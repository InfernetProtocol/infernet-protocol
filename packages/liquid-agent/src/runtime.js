/**
 * Locate, install and talk to the isolated `infernet-liquid` Python runtime.
 *
 * The runtime is never installed implicitly: `setupRuntime()` runs only from
 * `infernet model runtime setup` (or a caller that asked the operator first).
 * It builds a venv from the hash-pinned lock under
 * ~/.infernet/liquid/<lock>-<lock-hash-12>/ so a lock change gets a fresh venv.
 * Node never imports Python; everything crosses a stdio NDJSON pipe.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_CODES, RUNTIME_PROTOCOL_VERSION } from "./contract.js";

export const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime");
export const MIN_PYTHON = [3, 11];

export function lockFile(accelerator = "cpu") {
    return path.join(RUNTIME_DIR, accelerator === "cuda" ? "requirements-cuda.lock" : "requirements.lock");
}

export function lockHash(accelerator = "cpu") {
    return `sha256:${createHash("sha256").update(readFileSync(lockFile(accelerator))).digest("hex")}`;
}

export function runtimeHome(env = process.env) {
    return env.INFERNET_LIQUID_HOME ?? path.join(env.HOME ?? os.homedir(), ".infernet", "liquid");
}

export function venvDir(accelerator = "cpu", env = process.env) {
    return path.join(runtimeHome(env), `${accelerator}-${lockHash(accelerator).slice(7, 19)}`);
}

function venvPython(dir) {
    return process.platform === "win32" ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");
}

/** Where the runtime would run from, or null when it is not installed. */
export function resolveRuntime({ env = process.env, accelerator } = {}) {
    if (env.INFERNET_LIQUID_PYTHON) {
        return { python: env.INFERNET_LIQUID_PYTHON, accelerator: env.INFERNET_LIQUID_LOCK ?? "cpu", source: "env" };
    }
    for (const acc of accelerator ? [accelerator] : ["cuda", "cpu"]) {
        const dir = venvDir(acc, env);
        if (existsSync(path.join(dir, "installed.json")) && existsSync(venvPython(dir))) {
            return { python: venvPython(dir), accelerator: acc, source: dir };
        }
    }
    return null;
}

function pythonVersion(bin) {
    const r = spawnSync(bin, ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    const [maj, min] = r.stdout.trim().split(".").map(Number);
    return [maj, min];
}

export function findBasePython(env = process.env) {
    const candidates = [env.INFERNET_LIQUID_BASE_PYTHON, "python3.13", "python3.12", "python3.11", "python3", "python"].filter(Boolean);
    for (const bin of candidates) {
        const v = pythonVersion(bin);
        if (v && (v[0] > MIN_PYTHON[0] || (v[0] === MIN_PYTHON[0] && v[1] >= MIN_PYTHON[1]))) return { bin, version: v.join(".") };
    }
    return null;
}

/**
 * Create the venv and install the locked dependencies (pip --require-hashes).
 * `log` receives progress lines. Returns the resolved runtime.
 */
export async function setupRuntime({ accelerator = "cpu", env = process.env, log = () => {} } = {}) {
    const base = findBasePython(env);
    if (!base) throw Object.assign(new Error("Python 3.11+ not found; install python3 (3.11 or newer) first"), { code: "E_RUNTIME_MISSING" });
    const dir = venvDir(accelerator, env);
    mkdirSync(path.dirname(dir), { recursive: true });
    const run = (cmd, args) =>
        new Promise((resolve, reject) => {
            log(`$ ${cmd} ${args.join(" ")}`);
            const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...env, PIP_DISABLE_PIP_VERSION_CHECK: "1" } });
            child.stdout.on("data", (b) => log(b.toString().trimEnd()));
            child.stderr.on("data", (b) => log(b.toString().trimEnd()));
            child.on("error", reject);
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
        });
    if (!existsSync(venvPython(dir))) await run(base.bin, ["-m", "venv", dir]);
    await run(venvPython(dir), ["-m", "pip", "install", "--require-hashes", "--no-deps", "-r", lockFile(accelerator)]);
    const marker = { lock_hash: lockHash(accelerator), accelerator, python: base.version, installed_at: new Date().toISOString() };
    writeFileSync(path.join(dir, "installed.json"), JSON.stringify(marker, null, 2) + "\n");
    return { python: venvPython(dir), accelerator, source: dir };
}

export class RuntimeError extends Error {
    constructor({ code, message, retriable, ...extra }) {
        super(message);
        this.code = code;
        this.retriable = retriable ?? ERROR_CODES[code]?.retriable ?? false;
        Object.assign(this, extra);
    }
}

/**
 * One long-lived runtime process. `request(op, params, {onEvent, timeoutMs})`
 * resolves with the result or rejects with a RuntimeError carrying the
 * contract's error code.
 */
export class LiquidRuntime {
    constructor({ python, accelerator = "cpu", args = [], env = process.env, spawnImpl = spawn } = {}) {
        const rt = python ? { python, accelerator } : resolveRuntime({ env });
        if (!rt) {
            throw new RuntimeError({
                code: "E_RUNTIME_MISSING",
                message: "the infernet-liquid runtime is not installed; run `infernet model runtime setup` (downloads PyTorch + ncps, about 1 GB on CPU)"
            });
        }
        this.child = spawnImpl(rt.python, ["-m", "infernet_liquid", "serve", ...args], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...env, PYTHONPATH: RUNTIME_DIR, PYTHONUNBUFFERED: "1", INFERNET_LIQUID_LOCK: rt.accelerator }
        });
        this.pending = new Map();
        this.seq = 0;
        this.buf = "";
        this.stderr = "";
        this.closed = false;
        this.child.stdout.setEncoding("utf8");
        this.child.stdout.on("data", (chunk) => this.#onData(chunk));
        this.child.stderr?.on("data", (b) => {
            this.stderr = (this.stderr + b.toString()).slice(-8192);
        });
        this.child.on("exit", (code) => {
            this.closed = true;
            for (const p of this.pending.values()) {
                p.reject(new RuntimeError({ code: "E_RUNTIME", message: `infernet-liquid exited ${code}${this.stderr ? `: ${this.stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}` }));
            }
            this.pending.clear();
        });
        this.child.on("error", (err) => {
            this.closed = true;
            for (const p of this.pending.values()) p.reject(new RuntimeError({ code: "E_RUNTIME_MISSING", message: err.message }));
            this.pending.clear();
        });
    }

    #onData(chunk) {
        this.buf += chunk;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            const p = this.pending.get(msg.id);
            if (!p) continue;
            if (msg.event) {
                p.onEvent?.(msg);
                continue;
            }
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.result);
            else p.reject(new RuntimeError(msg.error ?? { code: "E_RUNTIME", message: "unknown runtime error" }));
        }
    }

    /** Send one op. `onId` receives the request id (to `cancel` a train/evaluate). */
    request(op, params = {}, { onEvent, timeoutMs, onId } = {}) {
        if (this.closed) return Promise.reject(new RuntimeError({ code: "E_RUNTIME", message: "runtime is not running" }));
        const id = `r${++this.seq}`;
        onId?.(id);
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, onEvent, timer: null };
            if (timeoutMs) {
                entry.timer = setTimeout(() => {
                    this.pending.delete(id);
                    if (op === "train" || op === "evaluate") this.child.stdin.write(JSON.stringify({ v: RUNTIME_PROTOCOL_VERSION, id: `c${id}`, op: "cancel", target: id }) + "\n");
                    reject(new RuntimeError({ code: "E_TIMEOUT", message: `${op} timed out after ${timeoutMs} ms` }));
                }, timeoutMs);
            }
            this.pending.set(id, entry);
            this.child.stdin.write(JSON.stringify({ v: RUNTIME_PROTOCOL_VERSION, id, op, ...params }) + "\n");
        });
    }

    cancel(id) {
        return this.request("cancel", { target: id }, { timeoutMs: 10000 });
    }

    async close() {
        if (this.closed) return;
        try {
            await this.request("shutdown", {}, { timeoutMs: 5000 });
        } catch {
            /* fall through to kill */
        }
        if (!this.closed) this.child.kill("SIGTERM");
    }
}
