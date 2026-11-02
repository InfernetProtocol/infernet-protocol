import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    parseManifest,
    assertManifestUrl,
    resolveSettings,
    planSync,
    verifyPulled,
    normalizeOllamaName,
    diskReserveBytes,
    syncHouseModels,
    readState,
    formatStatus
} from "../apps/cli/lib/house-models.js";
import { matchServedModel } from "../apps/web/lib/model-names.js";

const GB = 1024 ** 3;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const D = (c) => `sha256:${c.repeat(64)}`;
const doc = {
    schema: 1,
    models: [
        { name: "small", source: "hf.co/acme/small-GGUF", digest: D("a"), size_bytes: 0.5 * GB, min_ram_gb: 2, min_disk_gb: 1 },
        { name: "unc4", source: "huihui_ai/qwen3.5-abliterated:4b", digest: D("b"), size_bytes: 3.3 * GB, min_ram_gb: 8, min_disk_gb: 4, uncensored: true },
        { name: "unc9", source: "huihui_ai/qwen3.5-abliterated:9b", digest: D("c"), size_bytes: 6.6 * GB, min_ram_gb: 16, min_disk_gb: 7, uncensored: true }
    ]
};
const manifest = parseManifest(doc);
const on = { enabled: true, uncensored: true, maxDiskGb: null };
const bigBox = { ramGb: 32, diskFreeBytes: 200 * GB, diskTotalBytes: 500 * GB };

describe("house-models manifest", () => {
    it("parses entries and normalizes Ollama names", () => {
        expect(manifest.models.map((m) => m.ollama_name)).toEqual([
            "hf.co/acme/small-GGUF:latest",
            "huihui_ai/qwen3.5-abliterated:4b",
            "huihui_ai/qwen3.5-abliterated:9b"
        ]);
        expect(manifest.models[1].uncensored).toBe(true);
        expect(manifest.models[0].uncensored).toBe(false);
    });

    it("drops bad entries one by one instead of failing the list", () => {
        const m = parseManifest({ models: [
            { source: "ok/model:1b", size_bytes: 10, min_ram_gb: 1 },
            { source: "", size_bytes: 10, min_ram_gb: 1 },
            { source: "x/y", size_bytes: -1, min_ram_gb: 1 },
            { source: "x/z", size_bytes: 1, min_ram_gb: 1, digest: "md5:nope" },
            { source: "ok/model:1b", size_bytes: 10, min_ram_gb: 1 }
        ] });
        expect(m.models).toHaveLength(1);
        expect(m.rejected).toHaveLength(4);
    });

    it("rejects documents without a models array or an unknown schema", () => {
        expect(() => parseManifest({})).toThrow();
        expect(() => parseManifest({ schema: 2, models: [] })).toThrow(/schema/);
    });

    it("only fetches from https on our domains", () => {
        expect(assertManifestUrl("https://infernetprotocol.com/house-models.json")).toBeTruthy();
        expect(assertManifestUrl("https://c0mpute.com/house-models.json")).toBeTruthy();
        expect(() => assertManifestUrl("http://infernetprotocol.com/house-models.json")).toThrow(/https/);
        expect(() => assertManifestUrl("https://evil.example/house-models.json")).toThrow(/not one of/);
        expect(() => assertManifestUrl("https://infernetprotocol.com.evil.example/x.json")).toThrow();
    });

    it("the published manifest is valid and pinned", () => {
        const pub = JSON.parse(readFileSync(path.join(repoRoot, "apps/web/public/house-models.json"), "utf8"));
        const m = parseManifest(pub);
        expect(m.rejected).toEqual([]);
        expect(m.models.length).toBeGreaterThanOrEqual(3);
        for (const e of m.models) expect(e.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(m.models.find((e) => e.source === "hf.co/profullstack/saas-business-strategist-agent-GGUF")).toBeTruthy();
        expect(m.models.filter((e) => e.uncensored).map((e) => e.source).sort()).toEqual([
            "huihui_ai/qwen3.5-abliterated:4b", "huihui_ai/qwen3.5-abliterated:9b"
        ]);
    });
});

describe("house-models settings (opt-out)", () => {
    const args = (flags) => ({ has: (k) => k in flags, get: (k) => (flags[k] === true ? undefined : flags[k]) });

    it("is on by default, uncensored included", () => {
        const s = resolveSettings({ config: {}, env: {} });
        expect(s.enabled).toBe(true);
        expect(s.uncensored).toBe(true);
        expect(s.maxDiskGb).toBeNull();
    });

    it("config, env and flags each turn it off", () => {
        expect(resolveSettings({ config: { houseModels: { enabled: false } }, env: {} }).enabled).toBe(false);
        expect(resolveSettings({ config: {}, env: { INFERNET_HOUSE_MODELS: "0" } }).enabled).toBe(false);
        expect(resolveSettings({ config: {}, env: { INFERNET_NO_HOUSE_MODELS: "1" } }).enabled).toBe(false);
        expect(resolveSettings({ config: {}, env: {}, args: args({ "no-house-models": true }) }).enabled).toBe(false);
    });

    it("uncensored has its own opt-out that leaves the rest on", () => {
        for (const s of [
            resolveSettings({ config: { houseModels: { uncensored: false } }, env: {} }),
            resolveSettings({ config: {}, env: { INFERNET_UNCENSORED_MODELS: "off" } }),
            resolveSettings({ config: {}, env: {}, args: args({ "no-uncensored-models": true }) })
        ]) {
            expect(s.enabled).toBe(true);
            expect(s.uncensored).toBe(false);
        }
    });

    it("reads the disk cap from config, env and flag", () => {
        expect(resolveSettings({ config: { houseModels: { maxDiskGb: 5 } }, env: {} }).maxDiskGb).toBe(5);
        expect(resolveSettings({ config: {}, env: { INFERNET_HOUSE_MODELS_MAX_GB: "7" } }).maxDiskGb).toBe(7);
        expect(resolveSettings({ config: {}, env: {}, args: args({ "house-models-max-gb": "3" }) }).maxDiskGb).toBe(3);
    });
});

describe("house-models fit checks", () => {
    it("pulls everything on a big box", () => {
        const p = planSync({ manifest, capacity: bigBox, settings: on });
        expect(p.pull.map((m) => m.name)).toEqual(["small", "unc4", "unc9"]);
        expect(p.remove).toEqual([]);
    });

    it("gives a small node only what fits its RAM", () => {
        const p = planSync({ manifest, capacity: { ...bigBox, ramGb: 8 }, settings: on });
        expect(p.pull.map((m) => m.name)).toEqual(["small", "unc4"]);
        expect(p.skipped[0].reason).toMatch(/needs 16 GB RAM/);
        const tiny = planSync({ manifest, capacity: { ...bigBox, ramGb: 4 }, settings: on });
        expect(tiny.pull.map((m) => m.name)).toEqual(["small"]);
    });

    it("keeps the disk reserve: 10% of the disk, 10-50 GB", () => {
        expect(diskReserveBytes(50 * GB)).toBe(10 * GB);
        expect(diskReserveBytes(300 * GB)).toBe(30 * GB);
        expect(diskReserveBytes(2000 * GB)).toBe(50 * GB);
        // 938 GB disk with 80 GB free (a real node): reserve is 50 GB, so all fit.
        const real = planSync({ manifest, capacity: { ramGb: 30, diskFreeBytes: 80 * GB, diskTotalBytes: 938 * GB }, settings: on });
        expect(real.pull).toHaveLength(3);
        // 13 GB free on a 100 GB disk: the 10 GB reserve leaves room for small only.
        const tight = planSync({ manifest, capacity: { ramGb: 32, diskFreeBytes: 13 * GB, diskTotalBytes: 100 * GB }, settings: on });
        expect(tight.pull.map((m) => m.name)).toEqual(["small"]);
        expect(tight.skipped.map((s) => s.reason).join(" ")).toMatch(/not enough free disk/);
    });

    it("respects the operator's disk cap", () => {
        const p = planSync({ manifest, capacity: bigBox, settings: { ...on, maxDiskGb: 4 } });
        expect(p.pull.map((m) => m.name)).toEqual(["small", "unc4"]);
        expect(p.skipped[0].reason).toMatch(/disk cap/);
    });

    it("skips uncensored models when that opt-out is set", () => {
        const p = planSync({ manifest, capacity: bigBox, settings: { ...on, uncensored: false } });
        expect(p.pull.map((m) => m.name)).toEqual(["small"]);
    });

    it("backs off for a day after a failed pull", () => {
        const now = Date.parse("2026-11-02T12:00:00Z");
        const failures = { "hf.co/acme/small-GGUF:latest": { at: "2026-11-02T06:00:00Z", error: "digest mismatch" } };
        const p = planSync({ manifest, capacity: bigBox, settings: on, failures, now });
        expect(p.pull.map((m) => m.name)).toEqual(["unc4", "unc9"]);
        const later = planSync({ manifest, capacity: bigBox, settings: on, failures, now: now + 24 * 3600e3 });
        expect(later.pull).toHaveLength(3);
    });
});

describe("house-models removal", () => {
    const installed = [
        { name: "hf.co/acme/small-GGUF:latest", digest: D("a"), size: 0.5 * GB },
        { name: "huihui_ai/qwen3.5-abliterated:4b", digest: D("b"), size: 3.3 * GB },
        { name: "old/house:1b", digest: D("d"), size: GB },
        { name: "qwen2.5:7b", digest: D("e"), size: 4.4 * GB }
    ];
    const owned = { "hf.co/acme/small-GGUF:latest": {}, "huihui_ai/qwen3.5-abliterated:4b": {}, "old/house:1b": {} };

    it("removes owned models that left the manifest, never the operator's", () => {
        const p = planSync({ manifest, installed, owned, capacity: bigBox, settings: on });
        expect(p.remove.map((r) => r.name)).toEqual(["old/house:1b"]);
        expect(p.pull.map((m) => m.name)).toEqual(["unc9"]);
    });

    it("turning house models off removes only what the daemon pulled", () => {
        const operatorHad = { "hf.co/acme/small-GGUF:latest": {} }; // the 4b was the operator's own pull
        const p = planSync({ manifest, installed, owned: operatorHad, capacity: bigBox, settings: { ...on, enabled: false } });
        expect(p.remove.map((r) => r.name)).toEqual(["hf.co/acme/small-GGUF:latest"]);
        expect(p.skipped.find((s) => s.name === "huihui_ai/qwen3.5-abliterated:4b").reason).toMatch(/installed it yourself/);
        expect(p.pull).toEqual([]);
    });

    it("the uncensored opt-out removes owned uncensored models", () => {
        const p = planSync({ manifest, installed, owned, capacity: bigBox, settings: { ...on, uncensored: false } });
        expect(p.remove.map((r) => r.name).sort()).toEqual(["huihui_ai/qwen3.5-abliterated:4b", "old/house:1b"]);
    });
});

describe("house-models verification", () => {
    const entry = manifest.models[1];
    it("accepts a matching digest and size", () => {
        expect(verifyPulled(entry, { digest: "b".repeat(64), size: entry.size_bytes }).ok).toBe(true);
    });
    it("rejects a wrong digest or size", () => {
        expect(verifyPulled(entry, { digest: "f".repeat(64), size: entry.size_bytes }).error).toMatch(/digest/);
        expect(verifyPulled(entry, { digest: D("b"), size: entry.size_bytes * 2 }).error).toMatch(/size/);
        expect(verifyPulled(entry, null).ok).toBe(false);
    });
    it("normalizes untagged names to :latest", () => {
        expect(normalizeOllamaName("hf.co/a/b")).toBe("hf.co/a/b:latest");
        expect(normalizeOllamaName("a/b:4b")).toBe("a/b:4b");
        expect(normalizeOllamaName("localhost:11434/a/b")).toBe("localhost:11434/a/b:latest");
    });
});

describe("syncHouseModels against a fake Ollama", () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "house-models-")); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    function fakeOllama({ tags, digestFor = {} }) {
        const calls = [];
        const fetchImpl = async (url, init = {}) => {
            const u = new URL(url);
            calls.push(`${init.method ?? "GET"} ${u.pathname}`);
            if (u.pathname === "/api/tags") {
                return new Response(JSON.stringify({ models: tags }), { status: 200 });
            }
            if (u.pathname === "/api/pull") {
                const name = JSON.parse(init.body).name;
                const n = normalizeOllamaName(name);
                const e = manifest.models.find((m) => m.ollama_name === n);
                tags.push({ name: n, digest: digestFor[n] ?? e.digest.slice(7), size: e.size_bytes });
                return new Response('{"status":"pulling manifest"}\n{"status":"success"}\n', { status: 200 });
            }
            if (u.pathname === "/api/delete") {
                const n = normalizeOllamaName(JSON.parse(init.body).name);
                const i = tags.findIndex((t) => normalizeOllamaName(t.name) === n);
                if (i >= 0) tags.splice(i, 1);
                return new Response("", { status: 200 });
            }
            return new Response("nope", { status: 404 });
        };
        return { fetchImpl, calls };
    }

    const capacity = { ramGb: 32, disk: { freeBytes: 200 * GB, totalBytes: 500 * GB } };

    it("pulls one at a time, verifies, records ownership, and reports", async () => {
        const tags = [{ name: "qwen2.5:0.5b", digest: "9".repeat(64), size: 1 }];
        const { fetchImpl, calls } = fakeOllama({ tags, digestFor: { "huihui_ai/qwen3.5-abliterated:9b": "0".repeat(64) } });
        const statePath = path.join(dir, "state.json");
        const s = await syncHouseModels({ settings: on, manifest, fetchImpl, host: "http://ollama.test", statePath, capacity });
        expect(s.pulled).toEqual(["hf.co/acme/small-GGUF:latest", "huihui_ai/qwen3.5-abliterated:4b"]);
        expect(s.errors.map((e) => e.name)).toEqual(["huihui_ai/qwen3.5-abliterated:9b"]);
        expect(calls).toContain("DELETE /api/delete"); // the bad digest got removed
        const state = readState(statePath);
        expect(Object.keys(state.owned).sort()).toEqual(["hf.co/acme/small-GGUF:latest", "huihui_ai/qwen3.5-abliterated:4b"]);
        expect(state.failures["huihui_ai/qwen3.5-abliterated:9b"].error).toMatch(/digest mismatch/);
        expect(tags.map((t) => t.name)).toContain("qwen2.5:0.5b");
        const text = formatStatus({ settings: { ...on, sources: {} }, state });
        expect(text).toMatch(/House models: on; uncensored: on/);
        expect(text).toMatch(/huihui_ai\/qwen3.5-abliterated:4b {2}3.3 GB {2}\[uncensored\]/);
        expect(text).toMatch(/disk used by house models: 3.8 GB/);
    });

    it("does not start a pull while the node is busy", async () => {
        const { fetchImpl, calls } = fakeOllama({ tags: [] });
        const s = await syncHouseModels({ settings: on, manifest, fetchImpl, host: "http://ollama.test", statePath: path.join(dir, "s.json"), capacity, isBusy: () => true });
        expect(s.pulled).toEqual([]);
        expect(calls.filter((c) => c.includes("pull"))).toEqual([]);
    });

    it("opt-out removes what it pulled on the next sync", async () => {
        const tags = [];
        const { fetchImpl } = fakeOllama({ tags });
        const statePath = path.join(dir, "s.json");
        await syncHouseModels({ settings: { ...on, uncensored: false }, manifest, fetchImpl, host: "http://ollama.test", statePath, capacity });
        expect(tags.map((t) => t.name)).toEqual(["hf.co/acme/small-GGUF:latest"]);
        tags.push({ name: "mine:1b", digest: "1".repeat(64), size: 1 });
        const s = await syncHouseModels({ settings: { ...on, enabled: false }, manifest, fetchImpl, host: "http://ollama.test", statePath, capacity });
        expect(s.removed.map((r) => r.name)).toEqual(["hf.co/acme/small-GGUF:latest"]);
        expect(tags.map((t) => t.name)).toEqual(["mine:1b"]);
    });

    it("survives Ollama being down", async () => {
        const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
        const s = await syncHouseModels({ settings: on, manifest, fetchImpl, host: "http://ollama.test", statePath: path.join(dir, "s.json"), capacity });
        expect(s.errors[0].error).toMatch(/ECONNREFUSED/);
    });
});

describe("chat routing finds house models by either name", () => {
    it("matches with and without :latest", () => {
        const served = ["qwen2.5:0.5b", "hf.co/profullstack/saas-business-strategist-agent-GGUF:latest"];
        expect(matchServedModel(served, "hf.co/profullstack/saas-business-strategist-agent-GGUF")).toBe(served[1]);
        expect(matchServedModel(["hf.co/x/y"], "hf.co/x/y:latest")).toBe("hf.co/x/y");
        expect(matchServedModel(["qwen2.5:0.5b"], "qwen2.5")).toBeNull();
    });
});
