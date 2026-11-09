/**
 * PEFT backend — LoRA fine-tunes of causal language models on one provider,
 * CPU or CUDA. Workload `infernet.text.train`.
 *
 * Spawns `runners/peft_train.py <job.json>` in its own Python venv and relays
 * its stdout, which is already training-protocol v1 NDJSON (meta / step /
 * eval / checkpoint / done / error). Anything else on stdout is ignored;
 * stderr is the runner's human log.
 *
 * Job config (see runners/peft_train.py):
 *   { kind: "lora", base_model, system_prompt?, dataset: { url, sha256? },
 *     hyperparams?: {...}, output: { destination_url } }
 *
 * The venv is installed only on request (`infernet model runtime setup --peft
 * --yes`): CPU PyTorch + transformers + peft, about 1 GB.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncQueue } from "@infernetprotocol/engine";
import { TMSG, TRAINING_PROTOCOL_VERSION } from "../protocol.js";

export const PEFT_KINDS = Object.freeze(["lora", "peft"]);
export const RUNNER_PATH = fileURLToPath(new URL("../../runners/peft_train.py", import.meta.url));
export const PEFT_REQUIREMENTS = Object.freeze(["transformers>=4.46", "peft>=0.13", "safetensors>=0.4"]);
/**
 * Dataset record shapes runners/peft_train.py reads (its DATASET_FORMATS):
 * `text` ({title?, text}: one briefing exchange) and `messages` (a whole
 * multi-turn chat, loss on the assistant turns). Reported by
 * `infernet model runtime status --peft --json` so callers (c0mpute's text
 * workers) advertise only what this runner can train.
 */
export const PEFT_DATASET_FORMATS = Object.freeze(["text", "messages"]);

export function peftRuntimeDir() {
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    return path.join(base, "infernet", "peft");
}

/** The venv python, or null when the runtime is not installed. */
export function resolvePeftPython() {
    const explicit = process.env.INFERNET_PEFT_PYTHON;
    if (explicit) return existsSync(explicit) ? explicit : null;
    const py = path.join(peftRuntimeDir(), "venv", "bin", "python");
    return existsSync(py) ? py : null;
}

function run(cmd, args, log) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        const relay = (b) => b.toString().split("\n").filter(Boolean).forEach((l) => log?.(l));
        child.stdout.on("data", relay);
        child.stderr.on("data", relay);
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
    });
}

/** Create the venv and install CPU (or CUDA) PyTorch, transformers and peft. */
export async function setupPeftRuntime({ accelerator = "cpu", python = "python3", log } = {}) {
    const dir = peftRuntimeDir();
    await mkdir(dir, { recursive: true });
    const venv = path.join(dir, "venv");
    const py = path.join(venv, "bin", "python");
    if (!existsSync(py)) {
        try {
            await run(python, ["-m", "venv", venv], log);
        } catch (err) {
            // Debian/Ubuntu ship venv without ensurepip unless python3-venv is
            // installed (needs root). A pip-less venv plus get-pip.py works anyway.
            log?.(`python -m venv failed (${err.message}); retrying without pip`);
            await rm(venv, { recursive: true, force: true });
            await run(python, ["-m", "venv", "--without-pip", venv], log);
        }
    }
    const hasPip = await run(py, ["-m", "pip", "--version"]).then(() => true, () => false);
    if (!hasPip) {
        const getPip = path.join(dir, "get-pip.py");
        const res = await fetch("https://bootstrap.pypa.io/get-pip.py");
        if (!res.ok) throw new Error(`could not download get-pip.py: HTTP ${res.status}`);
        await writeFile(getPip, Buffer.from(await res.arrayBuffer()));
        await run(py, [getPip, "--quiet"], log);
    }
    await run(py, ["-m", "pip", "install", "--upgrade", "--quiet", "pip"], log);
    const torchIndex = accelerator === "cuda" ? [] : ["--index-url", "https://download.pytorch.org/whl/cpu"];
    await run(py, ["-m", "pip", "install", "--quiet", "torch", ...torchIndex], log);
    await run(py, ["-m", "pip", "install", "--quiet", ...PEFT_REQUIREMENTS], log);
    return { python: py, accelerator, runner: RUNNER_PATH };
}

/** Versions of the installed runtime, or null. */
export async function peftRuntimeStatus() {
    const py = resolvePeftPython();
    if (!py) return null;
    const code = "import json,torch,transformers,peft;print(json.dumps({'torch':torch.__version__,'transformers':transformers.__version__,'peft':peft.__version__,'cuda':torch.cuda.is_available()}))";
    return new Promise((resolve) => {
        const child = spawn(py, ["-c", code], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (b) => (out += b));
        child.on("error", () => resolve(null));
        child.on("close", (c) => {
            try {
                resolve(c === 0 ? { python: py, runner: RUNNER_PATH, formats: [...PEFT_DATASET_FORMATS], ...JSON.parse(out) } : null);
            } catch {
                resolve(null);
            }
        });
    });
}

export const GENERATE_RUNNER_PATH = fileURLToPath(new URL("../../runners/peft_generate.py", import.meta.url));

/**
 * One answer from a base model + LoRA adapter (workload infernet.text.infer).
 * `request` is the runner's request object; relative paths resolve against
 * `requestPath`'s directory when given. Resolves to the runner's answer
 * object; rejects with its error message.
 */
export async function peftGenerate({ request, requestPath = null, python = null, runner = GENERATE_RUNNER_PATH, timeoutMs = 600000, spawnImpl = spawn } = {}) {
    const py = python ?? resolvePeftPython();
    if (!py) throw Object.assign(new Error("the peft runtime is not installed; run `infernet model runtime setup --peft --yes`"), { code: "E_NO_RUNTIME" });
    let file = requestPath;
    if (!file) {
        const dir = await mkdtemp(path.join(os.tmpdir(), "infernet-generate-"));
        file = path.join(dir, "request.json");
        await writeFile(file, JSON.stringify(request));
    }
    return new Promise((resolve, reject) => {
        const child = spawnImpl(py, [runner, file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
        let out = "";
        const tail = [];
        child.stdout.on("data", (b) => (out += b));
        child.stderr.on("data", (b) => {
            for (const l of b.toString().split("\n").filter(Boolean)) {
                tail.push(l);
                if (tail.length > 20) tail.shift();
            }
        });
        const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
        child.on("error", reject);
        child.on("close", (code) => {
            clearTimeout(timer);
            const line = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).at(-1);
            let res = null;
            try {
                res = line ? JSON.parse(line) : null;
            } catch {
                res = null;
            }
            if (code === 0 && res?.type === "answer") return resolve(res);
            reject(Object.assign(new Error(res?.message ?? `generate exited ${code}: ${tail.at(-1) ?? "no output"}`), { code: "E_RUNTIME" }));
        });
    });
}

export function createPeftBackend({ python = null, runner = RUNNER_PATH, spawnImpl = spawn } = {}) {
    const children = new Set();
    return {
        kind: "peft",
        /**
         * `config` is the job object; `jobPath` (optional) is where it lives, so
         * the runner resolves relative dataset/output paths against it.
         */
        start({ config = {}, id, jobPath } = {}) {
            const jobId = id ?? config.id ?? randomUUID();
            const stream = new AsyncQueue();
            const push = (msg) => stream.push({ v: TRAINING_PROTOCOL_VERSION, id: jobId, ...msg });
            let cancelled = false;
            let child = null;

            (async () => {
                let sawDone = false;
                try {
                    const py = python ?? resolvePeftPython();
                    if (!py) throw Object.assign(new Error("the peft runtime is not installed; run `infernet model runtime setup --peft --yes`"), { code: "E_NO_RUNTIME" });
                    if (!PEFT_KINDS.includes(config.kind)) throw Object.assign(new Error(`job kind ${config.kind} is not a peft job (${PEFT_KINDS.join(", ")})`), { code: "E_BAD_JOB" });
                    let file = jobPath;
                    if (!file) {
                        const dir = await mkdtemp(path.join(os.tmpdir(), "infernet-peft-"));
                        file = path.join(dir, "job.json");
                        await writeFile(file, JSON.stringify({ ...config, id: jobId }, null, 2));
                    }
                    child = spawnImpl(py, [runner, file], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
                    children.add(child);
                    let buf = "";
                    child.stdout.on("data", (b) => {
                        buf += b.toString();
                        let nl;
                        while ((nl = buf.indexOf("\n")) >= 0) {
                            const line = buf.slice(0, nl).trim();
                            buf = buf.slice(nl + 1);
                            if (!line.startsWith("{")) continue;
                            try {
                                const ev = JSON.parse(line);
                                if (ev?.v !== TRAINING_PROTOCOL_VERSION || !ev.type) continue;
                                if (ev.type === TMSG.DONE) sawDone = true;
                                stream.push({ ...ev, id: jobId });
                            } catch {
                                /* not an event */
                            }
                        }
                    });
                    const tail = [];
                    child.stderr.on("data", (b) => {
                        for (const l of b.toString().split("\n").filter(Boolean)) {
                            tail.push(l);
                            if (tail.length > 20) tail.shift();
                        }
                    });
                    const code = await new Promise((resolve, reject) => {
                        child.on("error", reject);
                        child.on("close", resolve);
                    });
                    if (!sawDone) {
                        if (cancelled) push({ type: TMSG.DONE, reason: "cancel", finished_at: new Date().toISOString() });
                        else {
                            push({ type: TMSG.ERROR, message: `runner exited ${code}: ${tail.at(-1) ?? "no output"}`, code: "E_RUNTIME" });
                            push({ type: TMSG.DONE, reason: "error", finished_at: new Date().toISOString() });
                        }
                    }
                } catch (err) {
                    push({ type: TMSG.ERROR, message: err?.message ?? String(err), code: err?.code ?? "E_RUNTIME" });
                    push({ type: TMSG.DONE, reason: "error", finished_at: new Date().toISOString() });
                } finally {
                    if (child) children.delete(child);
                    stream.end();
                }
            })();

            return {
                id: jobId,
                stream,
                cancel: () => {
                    cancelled = true;
                    child?.kill("SIGTERM");
                }
            };
        },
        async shutdown() {
            for (const c of children) c.kill("SIGTERM");
            children.clear();
        }
    };
}
