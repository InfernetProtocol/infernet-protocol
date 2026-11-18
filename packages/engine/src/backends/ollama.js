/**
 * Ollama backend — talks to a local Ollama daemon over HTTP.
 *
 * Why this is the recommended default: Ollama already solves model
 * download + cache, multi-vendor GPU (CUDA / ROCm / Metal), the OpenAI-ish
 * chat API, and per-platform installers. We translate its NDJSON
 * `/api/chat` stream into our v1 protocol events.
 *
 * Discovery: `isOllamaReachable()` does a fast probe of `/api/tags`. The
 * factory in `index.js` calls it during auto-selection so a node with
 * Ollama running picks `ollama` automatically; nodes without it fall
 * through to `stub` (or `mojo` if `INFERNET_ENGINE_BIN` is set).
 *
 * Cancellation: each generation owns an AbortController; `cancel()`
 * aborts the in-flight fetch, which surfaces a `done` event with
 * `reason: "cancel"`.
 */

import os from "node:os";
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../async-queue.js";
import { MSG, PROTOCOL_VERSION } from "../protocol.js";

const DEFAULT_HOST = "http://localhost:11434";
const PROBE_TIMEOUT_MS = 500;

/**
 * Default thread cap for Ollama inference: half of the host's logical
 * cores, floored at 1. Set as `options.num_thread` on every /api/chat
 * call so a single inference job can't peg every core and starve the
 * rest of the system (the daemon's poll loop, UFW, ssh, the operator's
 * other workloads). Operators on dedicated boxes can lift the cap via
 * the OLLAMA_NUM_THREAD env var; nobody should have to touch it
 * otherwise.
 */
export function defaultNumThread() {
    const logical = Number.isFinite(os.cpus()?.length) ? os.cpus().length : 0;
    return Math.max(1, Math.floor(logical / 2));
}

export const OLLAMA_DEFAULT_HOST = DEFAULT_HOST;

/**
 * Default context cap for Ollama inference. A model whose Modelfile sets a
 * larger `num_ctx` is run at this size instead (options.num_ctx on every
 * /api/chat call); a model that sets a smaller one, or none, is left alone.
 *
 * Why: the house 9B (eriktonon/qwen3.8-uncensored:9b) ships num_ctx 65536.
 * At that size Ollama predicts 13.6 GiB for a 6 GB model, so on a 12 GB GPU
 * every model switch evicted and reloaded it, jobs hit the local timeout and
 * fell over to CPU nodes (~10 min); CPU nodes held 8.8 GB for it. 32768 is
 * plenty for chat. The cap is sent on every request so Ollama keeps a model
 * loaded at one size (a different num_ctx per request would reload it).
 * Lift or disable with INFERNET_OLLAMA_MAX_CTX (0 = no cap).
 */
export const DEFAULT_MAX_CTX = 32768;

export function resolveMaxCtx(value = process.env.INFERNET_OLLAMA_MAX_CTX) {
    if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_MAX_CTX;
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_CTX;
    return n; // 0 disables the cap
}

/** `num_ctx` from an /api/show `parameters` string ("num_ctx 65536\nstop ..."), or null. */
export function parseNumCtx(parameters) {
    if (typeof parameters !== "string") return null;
    const m = parameters.match(/^\s*num_ctx\s+(\d+)\s*$/m);
    return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * The context a request should ask for: the cap when the model's own
 * num_ctx is above it, otherwise null (send nothing, keep Ollama's choice).
 */
export function cappedNumCtx(modelCtx, maxCtx) {
    if (!Number.isFinite(maxCtx) || maxCtx <= 0) return null;
    if (!Number.isFinite(modelCtx) || modelCtx <= maxCtx) return null;
    return maxCtx;
}

/**
 * Minimal fetch over node:http for the /api/chat stream, with no headers or
 * body timeout.
 *
 * Node's global fetch (undici) fails with a bare "fetch failed" when no
 * response headers arrive within 300 s. Ollama sends headers with the first
 * token, and a single-GPU node serves one request at a time: a job queued
 * behind another generation, or a long prompt on a slow card, routinely
 * waits longer than that (cullen3, GTX 745, 2026-11-02: 47 of 49 qwen3:4b
 * jobs failed at ~300 s). The job already has its own expiry and cancel, so
 * the transport must not add a third, shorter deadline.
 *
 * Returns the subset of Response the backend uses: ok, status, text() and
 * an async-iterable body.
 */
export function ollamaHttpFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
    const u = url instanceof URL ? url : new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());
            return;
        }
        const req = mod.request(u, { method, headers }, (res) => {
            const status = res.statusCode ?? 0;
            resolve({
                ok: status >= 200 && status < 300,
                status,
                body: res,
                async text() {
                    let out = "";
                    res.setEncoding("utf8");
                    for await (const chunk of res) out += chunk;
                    return out;
                }
            });
        });
        const onAbort = () => req.destroy(abortError());
        signal?.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => signal?.removeEventListener("abort", onAbort));
        req.on("error", reject);
        if (body != null) req.write(body);
        req.end();
    });
}

function abortError() {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    return err;
}

export async function isOllamaReachable(host = DEFAULT_HOST, timeoutMs = PROBE_TIMEOUT_MS) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(new URL("/api/tags", host), { signal: ctrl.signal });
        clearTimeout(t);
        return res.ok;
    } catch {
        return false;
    }
}

export async function createOllamaBackend({
    host = process.env.OLLAMA_HOST ?? DEFAULT_HOST,
    defaultModel = process.env.INFERNET_ENGINE_MODEL ?? null,
    numThread = Number.parseInt(process.env.OLLAMA_NUM_THREAD ?? "", 10) || defaultNumThread(),
    maxCtx = resolveMaxCtx(),
    skipProbe = false,
    fetchImpl = ollamaHttpFetch
} = {}) {
    if (!skipProbe) {
        const ok = await isOllamaReachable(host);
        if (!ok) {
            throw new Error(
                `Ollama not reachable at ${host} — install from https://ollama.com or set OLLAMA_HOST`
            );
        }
    }

    // Model -> its Modelfile num_ctx (null when unset or /api/show failed).
    // A failed lookup is retried after a minute; a good one is kept.
    const ctxCache = new Map();
    async function modelNumCtx(model, signal) {
        const hit = ctxCache.get(model);
        if (hit && (hit.ok || Date.now() - hit.at < 60_000)) return hit.ctx;
        let ctx = null;
        let ok = false;
        try {
            const res = await fetchImpl(new URL("/api/show", host), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model }),
                signal
            });
            if (res?.ok && typeof res.text === "function") {
                const info = JSON.parse(await res.text());
                ctx = parseNumCtx(info?.parameters);
                ok = true;
            }
        } catch {
            // best-effort: no cap rather than no answer
        }
        ctxCache.set(model, { ctx, ok, at: Date.now() });
        return ctx;
    }

    return {
        kind: "ollama",
        host,
        numThread,
        maxCtx,
        generate({ messages, id, model = null, max_tokens, temperature } = {}) {
            const genId = id ?? randomUUID();
            const stream = new AsyncQueue();
            const ctrl = new AbortController();
            const resolvedModel = model ?? defaultModel;

            (async () => {
                if (!resolvedModel) {
                    stream.push({
                        v: PROTOCOL_VERSION,
                        type: MSG.ERROR,
                        id: genId,
                        message:
                            "ollama backend: no model — set INFERNET_ENGINE_MODEL or pass model in the job"
                    });
                    stream.end();
                    return;
                }

                const body = {
                    model: resolvedModel,
                    messages: Array.isArray(messages) ? messages : [],
                    stream: true,
                    // Qwen 3.5 and other reasoning models can spend the
                    // entire num_predict budget in their private thinking
                    // channel, leaving message.content empty.  Infernet's
                    // protocol carries the user-visible answer, not chain
                    // of thought, so request a normal answer stream.
                    think: false,
                    options: {}
                };
                if (typeof temperature === "number") body.options.temperature = temperature;
                if (typeof max_tokens === "number") body.options.num_predict = max_tokens;
                // Bound CPU usage by default so one inference can't peg
                // every core. Operator can lift the cap via OLLAMA_NUM_THREAD.
                if (Number.isFinite(numThread) && numThread > 0) {
                    body.options.num_thread = numThread;
                }
                // Cap a model whose Modelfile asks for a huge context (see
                // DEFAULT_MAX_CTX). Only looked up when a cap is set.
                if (Number.isFinite(maxCtx) && maxCtx > 0) {
                    const numCtx = cappedNumCtx(await modelNumCtx(resolvedModel, ctrl.signal), maxCtx);
                    if (numCtx) body.options.num_ctx = numCtx;
                }

                let res;
                try {
                    res = await fetchImpl(new URL("/api/chat", host), {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(body),
                        signal: ctrl.signal
                    });
                } catch (err) {
                    pushTerminal(stream, genId, ctrl, err, "");
                    return;
                }

                if (!res.ok) {
                    let detail = "";
                    try {
                        detail = await res.text();
                    } catch {
                        // best-effort
                    }
                    stream.push({
                        v: PROTOCOL_VERSION,
                        type: MSG.ERROR,
                        id: genId,
                        message: `ollama HTTP ${res.status}: ${detail.slice(0, 200)}`
                    });
                    stream.end();
                    return;
                }

                let metaSent = false;
                let acc = "";
                let buf = "";
                const decoder = new TextDecoder();

                try {
                    for await (const chunk of res.body) {
                        buf += decoder.decode(chunk, { stream: true });
                        let nl;
                        while ((nl = buf.indexOf("\n")) !== -1) {
                            const line = buf.slice(0, nl).trim();
                            buf = buf.slice(nl + 1);
                            if (!line) continue;
                            let parsed;
                            try {
                                parsed = JSON.parse(line);
                            } catch {
                                continue;
                            }

                            if (!metaSent) {
                                stream.push({
                                    v: PROTOCOL_VERSION,
                                    type: MSG.META,
                                    id: genId,
                                    model: parsed.model ?? resolvedModel,
                                    started_at: parsed.created_at ?? new Date().toISOString()
                                });
                                metaSent = true;
                            }

                            const text = parsed?.message?.content ?? "";
                            if (text) {
                                acc += text;
                                stream.push({
                                    v: PROTOCOL_VERSION,
                                    type: MSG.TOKEN,
                                    id: genId,
                                    text
                                });
                            }

                            if (parsed.done) {
                                stream.push({
                                    v: PROTOCOL_VERSION,
                                    type: MSG.DONE,
                                    id: genId,
                                    reason: parsed.done_reason ?? "stop",
                                    text: acc,
                                    finished_at: new Date().toISOString()
                                });
                                stream.end();
                                return;
                            }
                        }
                    }
                    // body ended without a `done:true` chunk — surface as stop.
                    stream.push({
                        v: PROTOCOL_VERSION,
                        type: MSG.DONE,
                        id: genId,
                        reason: "stop",
                        text: acc,
                        finished_at: new Date().toISOString()
                    });
                    stream.end();
                } catch (err) {
                    pushTerminal(stream, genId, ctrl, err, acc);
                }
            })().catch((err) => {
                stream.push({
                    v: PROTOCOL_VERSION,
                    type: MSG.ERROR,
                    id: genId,
                    message: err?.message ?? String(err)
                });
                stream.end();
            });

            return {
                id: genId,
                stream,
                cancel: () => ctrl.abort()
            };
        },
        async shutdown() {
            // The Ollama daemon is owned by the operator, not by us.
            // Nothing to clean up.
        }
    };
}

function pushTerminal(stream, genId, ctrl, err, accSoFar) {
    if (ctrl.signal.aborted) {
        stream.push({
            v: PROTOCOL_VERSION,
            type: MSG.DONE,
            id: genId,
            reason: "cancel",
            text: accSoFar,
            finished_at: new Date().toISOString()
        });
    } else {
        stream.push({
            v: PROTOCOL_VERSION,
            type: MSG.ERROR,
            id: genId,
            message: err?.message ?? String(err)
        });
    }
    stream.end();
}
