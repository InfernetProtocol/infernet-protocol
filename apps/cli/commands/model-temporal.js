/**
 * `infernet model train|evaluate|predict|serve|capabilities|runtime|synth` —
 * the temporal-policy family (workloads infernet.temporal.train and
 * infernet.temporal.infer): CfC/LTC liquid networks and a GRU baseline,
 * run by the isolated `infernet-liquid` Python runtime. Node only validates,
 * hashes and pipes NDJSON; Python never loads unless one of these runs.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
    FAMILIES,
    LiquidRuntime,
    RUNTIME_DIR,
    SCHEMA_VERSION,
    WORKLOADS,
    assertValid,
    lockHash,
    resolveRuntime,
    setupRuntime,
    verifyBundle
} from "@infernetprotocol/liquid-agent";

export const TEMPORAL_SUBCOMMANDS = new Set(["train", "evaluate", "eval", "predict", "serve", "capabilities", "runtime", "synth"]);

export const TEMPORAL_HELP = `
Temporal policies (workloads ${WORKLOADS.TRAIN}, ${WORKLOADS.INFER}):
  infernet model runtime [status]        Is the infernet-liquid runtime installed?
  infernet model runtime setup [--accelerator cpu|cuda] [--yes]
                                         Install it (PyTorch + ncps from a hash-pinned
                                         lock, ~1 GB on CPU). Never done implicitly.
  infernet model train --dataset <bundle.json> --output <dir>
                       [--family cfc|ltc|gru] [--baseline gru[,ltc]]
                       [--epochs N] [--seed N] [--hidden N] [--device auto|cpu|cuda]
                       [--job <train-job.json>] [--json]
                                         Train on a liquid-agent/v1 dataset bundle;
                                         writes model.safetensors + manifest.json.
                                         --baseline trains the others on the same
                                         splits and picks a winner by the rule.
  infernet model evaluate --model <dir> --dataset <bundle.json> [--split test|all] [--json]
  infernet model predict --model <dir> --input <steps.jsonl> [--session <id>]
                                         Feed observed steps, print action proposals.
  infernet model serve --stdio [--max-sessions N] [--ttl S] [--worker <id>]
                                         The runtime's NDJSON contract on stdin/stdout
                                         (what c0mpute's temporal serve drives).
  infernet model capabilities [--json]   Runtime, devices, RAM, families.
  infernet model synth --out <bundle.json> [--per-task N] [--seed N] [--shifted]
                                         Synthetic mock desktop traces (email,
                                         Reddit, LinkedIn mock sites) for testing.
`;

const flag = (args, name, fallback) => (args.has(name) ? args.get(name) : fallback);
const intFlag = (args, name) => (args.has(name) ? Number.parseInt(args.get(name), 10) : undefined);

function out(args, obj, text) {
    process.stdout.write(args.has("json") ? `${JSON.stringify(obj, null, 2)}\n` : text);
}

async function readJson(p) {
    return JSON.parse(await readFile(p, "utf8"));
}

async function cmdRuntime(args) {
    const sub = args.positional?.[1] ?? "status";
    const accelerator = flag(args, "accelerator", "cpu");
    if (sub === "setup") {
        if (!args.has("yes") && !args.has("y") && process.env.INFERNET_NONINTERACTIVE !== "1") {
            process.stdout.write(
                `This installs the infernet-liquid runtime: Python venv + PyTorch (${accelerator}) + ncps from\n` +
                    `${path.relative(process.cwd(), path.join(RUNTIME_DIR, accelerator === "cuda" ? "requirements-cuda.lock" : "requirements.lock"))}\n` +
                    `(about ${accelerator === "cuda" ? "5" : "1"} GB). Re-run with --yes to proceed.\n`
            );
            return 1;
        }
        const rt = await setupRuntime({ accelerator, log: (l) => process.stderr.write(`${l}\n`) });
        process.stdout.write(`installed: ${rt.python} (${rt.accelerator}, lock ${lockHash(accelerator)})\n`);
        return 0;
    }
    const rt = resolveRuntime();
    if (!rt) {
        out(args, { installed: false }, "infernet-liquid runtime: not installed (infernet model runtime setup --yes)\n");
        return 1;
    }
    const r = new LiquidRuntime(rt);
    try {
        const h = await r.request("health", {}, { timeoutMs: 120000 });
        out(args, { installed: true, ...rt, health: h }, `infernet-liquid ${h.runtime.version}: python ${h.runtime.python}, torch ${h.runtime.torch}, ncps ${h.runtime.ncps}, cuda ${h.devices.cuda}\n  ${rt.source}\n`);
        return 0;
    } finally {
        await r.close();
    }
}

async function cmdCapabilities(args) {
    const rt = resolveRuntime();
    if (!rt) {
        out(args, { workloads: [], runtime: null }, "temporal workloads: none (runtime not installed)\n");
        return 1;
    }
    const r = new LiquidRuntime(rt);
    try {
        const caps = await r.request("capabilities", {}, { timeoutMs: 120000 });
        out(args, caps, `workloads: ${caps.workloads.join(", ")}\nfamilies: ${caps.families.join(", ")} (research: ${caps.research_families.join(", ")})\ncuda: ${caps.devices.cuda}  ram: ${caps.ram_mb} MB  threads: ${caps.threads}\n`);
        return 0;
    } finally {
        await r.close();
    }
}

function fmtMetrics(m) {
    const f = (k) => (typeof m[k] === "number" ? m[k].toFixed(3) : "n/a");
    return `episode_success ${f("episode_success")}  step_accuracy ${f("step_accuracy")}  target_accuracy ${f("target_accuracy")}  ext_write_recall ${f("external_write_recall")}  p50 ${f("latency_ms_p50")} ms`;
}

/** Pick by the PRD rule: a liquid family wins only if it beats every baseline on episode_success. */
export function selectFamily(results) {
    const baseline = results.find((r) => r.family === "gru") ?? results[0];
    const liquid = results.filter((r) => r.family !== baseline.family);
    const better = liquid
        .filter((r) => r.eval.metrics.episode_success > baseline.eval.metrics.episode_success)
        .sort((a, b) => b.eval.metrics.episode_success - a.eval.metrics.episode_success);
    return better[0] ?? baseline;
}

async function cmdTrain(args) {
    const datasetPath = flag(args, "dataset");
    const output = flag(args, "output");
    if (!datasetPath || !output) {
        process.stderr.write("error: --dataset <bundle.json> and --output <dir> are required\n");
        return 2;
    }
    const bundle = await readJson(datasetPath);
    const datasetHash = verifyBundle(bundle);
    let job = null;
    if (args.has("job")) job = assertValid(await readJson(args.get("job")), "train_job");
    const family = job?.model_type ?? flag(args, "family", "cfc");
    if (!FAMILIES.includes(family)) {
        process.stderr.write(`error: --family must be one of ${FAMILIES.join(", ")}\n`);
        return 2;
    }
    const baselines = String(flag(args, "baseline", (job?.baselines ?? []).join(",")) || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== family);
    const hyper = Object.fromEntries(
        Object.entries({ epochs: intFlag(args, "epochs"), seed: intFlag(args, "seed"), hidden_units: intFlag(args, "hidden") }).filter(([, v]) => v !== undefined)
    );
    const families = [family, ...baselines];
    const r = new LiquidRuntime();
    const results = [];
    try {
        for (const fam of families) {
            const dir = families.length > 1 ? path.join(output, fam) : output;
            const params = {
                bundle_path: path.resolve(datasetPath),
                output_dir: path.resolve(dir),
                family: fam,
                hyperparameters: hyper,
                device: flag(args, "device", "auto")
            };
            if (job) params.job = fam === family ? job : { ...job, model_type: fam };
            if (!args.has("json")) process.stderr.write(`training ${fam} on ${datasetHash.slice(0, 19)}…\n`);
            const res = await r.request("train", params, {
                timeoutMs: (job?.limits?.timeout_s ?? 6 * 3600) * 1000,
                onEvent: (ev) => {
                    if (!args.has("json") && ev.event === "epoch") process.stderr.write(`  ${fam} epoch ${ev.epoch} loss ${ev.loss} val_step_acc ${ev.val_step_accuracy}\n`);
                }
            });
            results.push({ family: fam, model_dir: res.model_dir, model_hash: res.manifest.weights.weights_hash, eval: res.eval });
        }
    } finally {
        await r.close();
    }
    const chosen = selectFamily(results);
    if (results.length > 1) {
        await mkdir(output, { recursive: true });
        await writeFile(path.join(output, "comparison.json"), JSON.stringify({ schema_version: SCHEMA_VERSION, dataset_hash: datasetHash, results, selected: chosen.family, rule: "liquid family selected only if it beats the GRU baseline on episode_success" }, null, 2) + "\n");
    }
    let text = "";
    for (const res of results) text += `${res.family.padEnd(4)} ${res.model_hash}\n     ${fmtMetrics(res.eval.metrics)}\n     ${res.model_dir}\n`;
    if (results.length > 1) text += `selected: ${chosen.family} (a liquid family wins only if it beats the GRU baseline)\n`;
    out(args, { dataset_hash: datasetHash, results, selected: chosen.family }, text);
    return 0;
}

async function cmdEvaluate(args) {
    const model = flag(args, "model");
    const dataset = flag(args, "dataset");
    if (!model || !dataset) {
        process.stderr.write("error: --model <dir> and --dataset <bundle.json> are required\n");
        return 2;
    }
    verifyBundle(await readJson(dataset));
    const r = new LiquidRuntime();
    try {
        const res = await r.request("evaluate", { model_dir: path.resolve(model), bundle_path: path.resolve(dataset), split: flag(args, "split", "test") }, { timeoutMs: 3600 * 1000 });
        out(args, res, `${res.model_hash}\n${res.split}: ${fmtMetrics(res.metrics)}\n`);
        return 0;
    } finally {
        await r.close();
    }
}

async function cmdPredict(args) {
    const model = flag(args, "model");
    const input = flag(args, "input");
    if (!model || !input) {
        process.stderr.write("error: --model <dir> and --input <steps.jsonl> are required\n");
        return 2;
    }
    const steps = (await readFile(input, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const sessionId = flag(args, "session", `local-${Date.now()}`);
    const r = new LiquidRuntime();
    try {
        const loaded = await r.request("load", { model_dir: path.resolve(model), abstain_threshold: Number(flag(args, "threshold", 0.5)) }, { timeoutMs: 120000 });
        await r.request("open_session", { model_hash: loaded.model_hash, session_id: sessionId });
        let prev = null;
        for (const [i, step] of steps.entries()) {
            const request = {
                schema_version: SCHEMA_VERSION,
                kind: "predict_request",
                session_id: sessionId,
                model_hash: loaded.model_hash,
                sequence_index: i,
                dt_ms: step.dt_ms ?? 0,
                ...(step.task ? { task: step.task } : {}),
                observation: step.observation,
                prev_action: step.prev_action ?? prev
            };
            const p = await r.request("predict", { request });
            process.stdout.write(`${JSON.stringify(p)}\n`);
            prev = step.action ?? p.action;
        }
        await r.request("close_session", { session_id: sessionId });
        return 0;
    } finally {
        await r.close();
    }
}

function passthrough(rt, pyArgs) {
    return new Promise((resolve) => {
        const child = spawn(rt.python, ["-m", "infernet_liquid", ...pyArgs], {
            stdio: "inherit",
            env: { ...process.env, PYTHONPATH: RUNTIME_DIR, PYTHONUNBUFFERED: "1", INFERNET_LIQUID_LOCK: rt.accelerator }
        });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", (e) => {
            process.stderr.write(`error: ${e.message}\n`);
            resolve(1);
        });
    });
}

function requireRuntime() {
    const rt = resolveRuntime();
    if (!rt) process.stderr.write("error: the infernet-liquid runtime is not installed; run `infernet model runtime setup --yes`\n");
    return rt;
}

async function cmdServe(args) {
    const rt = requireRuntime();
    if (!rt) return 1;
    const extra = [];
    if (args.has("max-sessions")) extra.push("--max-sessions", String(args.get("max-sessions")));
    if (args.has("ttl")) extra.push("--ttl", String(args.get("ttl")));
    if (args.has("worker")) extra.push("--worker", String(args.get("worker")));
    return passthrough(rt, ["serve", ...extra]);
}

async function cmdSynth(args) {
    const rt = requireRuntime();
    if (!rt) return 1;
    const outPath = flag(args, "out");
    if (!outPath) {
        process.stderr.write("error: --out <bundle.json> is required\n");
        return 2;
    }
    const pyArgs = ["synth", "--out", path.resolve(outPath), "--per-task", String(flag(args, "per-task", 160)), "--seed", String(flag(args, "seed", 7))];
    if (args.has("shifted")) pyArgs.push("--shifted");
    return passthrough(rt, pyArgs);
}

export async function runTemporal(sub, args) {
    switch (sub) {
        case "runtime":
            return cmdRuntime(args);
        case "capabilities":
            return cmdCapabilities(args);
        case "train":
            return cmdTrain(args);
        case "evaluate":
        case "eval":
            return cmdEvaluate(args);
        case "predict":
            return cmdPredict(args);
        case "serve":
            return cmdServe(args);
        case "synth":
            return cmdSynth(args);
        default:
            throw new Error(`not a temporal subcommand: ${sub}`);
    }
}
