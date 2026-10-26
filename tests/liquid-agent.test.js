import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    EXTERNAL_WRITE_ACTIONS,
    LiquidRuntime,
    WORKLOADS,
    buildBundle,
    canonicalize,
    datasetHash,
    episodeHash,
    hashCanonical,
    resolveRuntime,
    scanSecrets,
    sealEpisode,
    validate,
    verifyBundle
} from "@infernetprotocol/liquid-agent";
import { createTrainer } from "../packages/training/src/index.js";
import { selectFamily } from "../apps/cli/commands/model-temporal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "packages/liquid-agent");
const fix = (...p) => path.join(pkg, "fixtures", ...p);
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const fake = path.join(root, "tests/fixtures/fake-liquid-runtime.mjs");
const fakeSpawn = (cmd, args, opts) => spawn(process.execPath, [fake], opts);
const cli = path.join(root, "apps/cli/index.js");

describe("liquid-agent/v1 contract", () => {
    it("accepts every valid fixture and rejects every invalid one", () => {
        for (const f of readdirSync(fix("valid"))) {
            const r = validate(load(fix("valid", f)));
            expect(r.errors, f).toEqual([]);
        }
        for (const f of readdirSync(fix("invalid"))) {
            const { kind, value } = load(fix("invalid", f));
            expect(validate(value, kind).ok, f).toBe(false);
        }
    });

    it("hashes exactly like the Python runtime (fixtures were hashed in Python)", () => {
        const c = load(fix("contract.json"));
        const bundle = load(fix("valid", "dataset-bundle.json"));
        expect(datasetHash(bundle.manifest)).toBe(c.bundle_dataset_hash);
        expect(episodeHash(bundle.episodes[0])).toBe(c.episode_content_hash);
        const schemas = Object.fromEntries(
            readdirSync(path.join(pkg, "schemas")).filter((f) => f.endsWith(".schema.json")).sort().map((f) => [f, load(path.join(pkg, "schemas", f))])
        );
        expect(hashCanonical(schemas)).toBe(c.schemas_hash);
        expect(verifyBundle(bundle)).toBe(c.bundle_dataset_hash);
    });

    it("canonical numbers match Python's canonicalizer", () => {
        expect(canonicalize({ b: 1.0, a: [0.5, 1e21, 1e-7, -0, 3] })).toBe('{"a":[0.5,1e+21,1e-7,0,3],"b":1}');
    });

    it("builds the same splits and dataset hash in JS as Python did", () => {
        const bundle = load(fix("valid", "dataset-bundle.json"));
        const rebuilt = buildBundle(bundle.episodes, { consent: bundle.manifest.consent, seed: 3, validation: 0.15, test: 0.25, provenance: { source: "synthetic" } });
        expect(rebuilt.manifest.dataset_hash).toBe(bundle.manifest.dataset_hash);
        expect(rebuilt.manifest.splits.counts).toEqual(bundle.manifest.splits.counts);
    });

    it("refuses unreviewed, tampered or secret-bearing episodes", () => {
        const bundle = load(fix("valid", "dataset-bundle.json"));
        const consent = bundle.manifest.consent;
        const ep = structuredClone(bundle.episodes[0]);
        ep.labels.reviewed = false;
        expect(() => buildBundle([sealEpisode(ep)], { consent })).toThrow(/not been reviewed/);
        const tampered = structuredClone(bundle.episodes[0]);
        tampered.labels.risk = "high";
        expect(() => buildBundle([tampered], { consent })).toThrow(/content_hash/);
        const leaky = structuredClone(bundle.episodes[0]);
        leaky.steps[0].action = { type: "type", target: { role: "textbox", name: "Password" }, text: "password: hunter22" };
        expect(() => buildBundle([sealEpisode(leaky)], { consent })).toThrow(/secret/);
        expect(() => buildBundle([bundle.episodes[0]], {})).toThrow(/consent/);
        const t2 = structuredClone(bundle);
        t2.episodes[1].steps[0].t_ms += 1;
        expect(() => verifyBundle(t2)).toThrow(/hash/);
    });

    it("secret scan finds keys and cards but not ids or timestamps", () => {
        expect(scanSecrets({ name: "Reply", t_ms: "4111111111111111", episode_id: "ep_4111111111111111" })).toEqual([]);
        const kinds = scanSecrets({ a: "Bearer abcdefghijklmnop1234", b: "-----BEGIN OPENSSH PRIVATE KEY-----", c: "card 4111-1111-1111-1111" }).flatMap((h) => h.kinds);
        expect(kinds).toEqual(expect.arrayContaining(["bearer", "private_key", "card_number"]));
    });

    it("names the workloads and treats posting/sending/deleting as external writes", () => {
        expect(WORKLOADS).toEqual({ TRAIN: "infernet.temporal.train", INFER: "infernet.temporal.infer" });
        expect(EXTERNAL_WRITE_ACTIONS).toEqual(expect.arrayContaining(["post", "send", "publish", "delete", "submit"]));
    });
});

describe("runtime client (fake runtime)", () => {
    it("round-trips ops, streams events and maps error codes", async () => {
        const r = new LiquidRuntime({ python: "fake", spawnImpl: fakeSpawn });
        expect(await r.request("health")).toEqual({ status: "ok" });
        const events = [];
        const res = await r.request("train", { output_dir: "/x" }, { onEvent: (e) => events.push(e.epoch) });
        expect(events).toEqual([1, 2]);
        expect(res.model_dir).toBe("/x");
        await expect(r.request("predict", {})).rejects.toMatchObject({ code: "E_SEQ_LATE", retriable: false, expected: 4 });
        await expect(r.request("hang", {}, { timeoutMs: 50 })).rejects.toMatchObject({ code: "E_TIMEOUT", retriable: true });
        await r.close();
    });

    it("rejects pending requests with the runtime's last stderr when it dies", async () => {
        const r = new LiquidRuntime({ python: "fake", spawnImpl: fakeSpawn });
        await expect(r.request("crash")).rejects.toThrow(/exited 3.*boom/);
    });

    it("is never found when not installed, and says how to install", () => {
        const home = mkdtempSync(path.join(os.tmpdir(), "liq-"));
        expect(resolveRuntime({ env: { HOME: home } })).toBeNull();
        expect(() => new LiquidRuntime({ env: { HOME: home } })).toThrow(/infernet model runtime setup/);
    });

    it("selects a liquid family only when it beats the GRU baseline", () => {
        const m = (family, s) => ({ family, eval: { metrics: { episode_success: s } } });
        expect(selectFamily([m("cfc", 0.9), m("gru", 0.9)]).family).toBe("gru");
        expect(selectFamily([m("cfc", 0.95), m("gru", 0.9)]).family).toBe("cfc");
        expect(selectFamily([m("cfc", 0.8), m("gru", 0.9), m("ltc", 0.92)]).family).toBe("ltc");
    });
});

describe("training backend: liquid", () => {
    it("maps runtime events to the v1 training protocol", async () => {
        const t = await createTrainer({ backend: "liquid", runtimeFactory: () => new LiquidRuntime({ python: "fake", spawnImpl: fakeSpawn }) });
        const { stream } = t.start({ config: { kind: "temporal-policy", dataset: { url: "/b.json" }, output: { destination_url: "/out" }, family: "cfc" } });
        const types = [];
        for await (const ev of stream) types.push(ev.type === "done" ? `done:${ev.reason}` : ev.type);
        expect(types).toEqual(["meta", "step", "step", "eval", "checkpoint", "done:complete"]);
        await t.shutdown();
    });
});

describe("infernet model (temporal) CLI without the runtime", () => {
    const env = { ...process.env, HOME: mkdtempSync(path.join(os.tmpdir(), "liq-cli-")), INFERNET_LIQUID_PYTHON: "" };
    delete env.INFERNET_LIQUID_PYTHON;
    it("runtime status says not installed and exits 1", () => {
        const r = spawnSync(process.execPath, [cli, "model", "runtime"], { env, encoding: "utf8" });
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/not installed/);
    });
    it("runtime setup refuses without --yes", () => {
        const r = spawnSync(process.execPath, [cli, "model", "runtime", "setup"], { env, encoding: "utf8" });
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/--yes/);
    });
    it("train validates the dataset before needing Python, then explains the missing runtime", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "liq-train-"));
        const bad = path.join(dir, "bad.json");
        writeFileSync(bad, JSON.stringify({ kind: "dataset_bundle" }));
        let r = spawnSync(process.execPath, [cli, "model", "train", "--dataset", bad, "--output", dir], { env, encoding: "utf8" });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/E_SCHEMA/);
        r = spawnSync(process.execPath, [cli, "model", "train", "--dataset", fix("valid", "dataset-bundle.json"), "--output", dir], { env, encoding: "utf8" });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/E_RUNTIME_MISSING/);
    });
    it("help lists the temporal subcommands", () => {
        const r = spawnSync(process.execPath, [cli, "model", "--help"], { env, encoding: "utf8" });
        expect(r.stdout).toMatch(/infernet\.temporal\.train/);
    });
});

// Real runtime: set INFERNET_LIQUID_PYTHON to a venv python with the lock installed (CI's liquid job does).
const realPython = process.env.INFERNET_LIQUID_PYTHON;
describe.skipIf(!realPython)("infernet model train/evaluate/predict (real runtime)", () => {
    it("trains CfC with a GRU baseline, evaluates and serves a session", { timeout: 300000 }, () => {
        const out = mkdtempSync(path.join(os.tmpdir(), "liq-real-"));
        const data = fix("valid", "dataset-bundle.json");
        let r = spawnSync(process.execPath, [cli, "model", "train", "--dataset", data, "--output", out, "--family", "cfc", "--baseline", "gru", "--epochs", "3", "--json"], { encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        const res = JSON.parse(r.stdout);
        expect(res.results.map((x) => x.family)).toEqual(["cfc", "gru"]);
        const manifest = load(path.join(out, "cfc", "manifest.json"));
        expect(validate(manifest).errors).toEqual([]);
        expect(existsSync(path.join(out, "comparison.json"))).toBe(true);
        r = spawnSync(process.execPath, [cli, "model", "evaluate", "--model", path.join(out, "cfc"), "--dataset", data, "--split", "all", "--json"], { encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        expect(JSON.parse(r.stdout).model_hash).toBe(manifest.weights.weights_hash);
        const ep = load(data).episodes[0];
        const steps = ep.steps.map((s, i) => ({ task: ep.task, observation: s.observation, dt_ms: i ? s.t_ms - ep.steps[i - 1].t_ms : 0, action: s.action }));
        const jsonl = path.join(out, "steps.jsonl");
        writeFileSync(jsonl, steps.map((s) => JSON.stringify(s)).join("\n"));
        r = spawnSync(process.execPath, [cli, "model", "predict", "--model", path.join(out, "cfc"), "--input", jsonl, "--threshold", "0"], { encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        const proposals = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
        expect(proposals).toHaveLength(steps.length);
        for (const p of proposals) expect(validate(p).errors).toEqual([]);
    });
});
