/**
 * Chat executor for the provider daemon.
 *
 * Pulls tokens from `@infernetprotocol/engine` (Mojo+MAX binary or
 * in-process stub, depending on env) and forwards them to the control
 * plane's `job_events` stream via signed POSTs. The daemon doesn't know
 * which engine backend is loaded — that's `createEngine()`'s problem.
 *
 * Backend selection precedence (set by the operator at daemon start):
 *   1. INFERNET_ENGINE_BACKEND=mojo|stub
 *   2. INFERNET_ENGINE_BIN set → mojo
 *   3. otherwise → stub (canned tokens, daemon still works on a fresh box)
 */

import { createEngine, MSG } from "@infernetprotocol/engine";
import { loadConfig } from "./config.js";
import { getConversationKey, decrypt, encrypt } from "./nip44.js";
import { getModelKeyPair } from "./model-key.js";

// Flush the event buffer when it hits this many tokens OR when we haven't
// flushed in this many ms. After merging (see mergeTokens), each flush
// produces at most one token row in job_events → one Supabase Realtime
// push → one SSE frame, regardless of how many model tokens accumulated.
const EVENT_BATCH_MAX = 16;
const EVENT_BATCH_FLUSH_MS = 250;

/**
 * Merge consecutive token events in a batch into a single token event
 * by concatenating their text. Non-token events preserve order.
 *
 * Before: [meta, token("H"), token("el"), token("lo"), done]
 * After:  [meta, token("Hello"), done]
 *
 * This reduces Supabase Realtime row-insert count from n_tokens to
 * n_flushes, cutting streaming latency by ~10-20x (IPIP-0024).
 */
function mergeTokens(events) {
    const out = [];
    let tokenText = "";
    for (const ev of events) {
        if (ev.event_type === "token") {
            tokenText += ev.data?.text ?? "";
        } else {
            if (tokenText) {
                out.push({ event_type: "token", data: { text: tokenText } });
                tokenText = "";
            }
            out.push(ev);
        }
    }
    if (tokenText) {
        out.push({ event_type: "token", data: { text: tokenText } });
    }
    return out;
}

class EventBuffer {
    constructor(client, jobId, conversationKey = null) {
        this.client = client;
        this.jobId = jobId;
        this.conversationKey = conversationKey;
        this.events = [];
        this.lastFlush = Date.now();
    }
    async push(event_type, data) {
        this.events.push({ event_type, data });
        if (
            this.events.length >= EVENT_BATCH_MAX ||
            Date.now() - this.lastFlush >= EVENT_BATCH_FLUSH_MS
        ) {
            await this.flush();
        }
    }
    async flush() {
        if (this.events.length === 0) return;
        const batch = mergeTokens(this.events).map((event) => {
            if (!this.conversationKey) return event;
            if (event.event_type === "token") {
                return {
                    ...event,
                    data: { encrypted_text: encrypt(this.conversationKey, event.data?.text ?? "") }
                };
            }
            if (event.event_type === "done") {
                const { text = "", ...metadata } = event.data ?? {};
                return {
                    ...event,
                    data: {
                        ...metadata,
                        encrypted_text: encrypt(this.conversationKey, text)
                    }
                };
            }
            return event;
        });
        this.events = [];
        this.lastFlush = Date.now();
        try {
            await this.client.postJobEvents(this.jobId, batch);
        } catch (err) {
            process.stderr.write(`postJobEvents failed: ${err?.message ?? err}\n`);
            throw err;
        }
    }
}

// One engine per daemon process — model load happens once. Lazy so the CLI
// doesn't pay the cost (or pull in the Mojo binary) until the first chat
// job actually arrives.
//
// We pull engine.{backend,model,ollamaHost} from the saved config so the
// daemon defaults to whatever `infernet setup` chose. The Ollama backend
// uses `defaultModel` when the job doesn't specify one (the playground
// /chat endpoint sometimes doesn't pass a model name). Without this
// fallback, every model-unspecified job died with
// "ollama backend: no model — set INFERNET_ENGINE_MODEL or pass model in the job"
// One engine per backend, cached. We route PER MODEL: if the requested model
// is being served by vLLM (:8000), use the vLLM engine; otherwise the default
// (config backend or auto-select → Ollama). This is what makes vLLM the actual
// serving path for hf: models while Ollama keeps handling its own tags.
const engineCache = new Map(); // cacheKey -> Promise<engine>

function buildEngine(cacheKey, opts) {
    if (!engineCache.has(cacheKey)) {
        const p = (async () => createEngine(opts))().catch((err) => {
            // Reset so a transient failure doesn't permanently poison the
            // daemon — next job will retry initialization.
            engineCache.delete(cacheKey);
            throw err;
        });
        engineCache.set(cacheKey, p);
    }
    return engineCache.get(cacheKey);
}

/**
 * The stub backend answers with canned text. That is fine when an operator
 * asked for it (`--backend stub`, INFERNET_ENGINE_BACKEND=stub) and wrong
 * everywhere else: auto-select falls back to it whenever no engine answers
 * its probe, e.g. Ollama busy for a moment, and the daemon then served
 * "This is a stub response ..." to real chat users for the rest of its life
 * (seen on c0mpute.com chat 2026-11-11). Exported for tests.
 */
export function stubExplicitlyChosen(config = {}, env = process.env) {
    return env.INFERNET_ENGINE_BACKEND === 'stub' || config?.engine?.backend === 'stub';
}

async function defaultEngine() {
    const config = (await loadConfig()) ?? {};
    const eng = config.engine ?? {};
    const opts = {};
    if (eng.backend) opts.backend = eng.backend;
    if (eng.model) opts.defaultModel = eng.model;
    if (eng.ollamaHost) opts.host = eng.ollamaHost;
    // Optional override for the per-request num_thread cap. Default (50% of
    // cores) is computed inside the Ollama backend; only forward when set.
    if (Number.isFinite(eng.ollama_num_thread) && eng.ollama_num_thread > 0) {
        opts.numThread = eng.ollama_num_thread;
    }
    const cacheKey = `default:${eng.backend ?? 'auto'}`;
    const engine = await buildEngine(cacheKey, opts);
    if (engine.kind === 'stub' && !stubExplicitlyChosen(config)) {
        // Do not keep it: the next job probes the real engines again.
        engineCache.delete(cacheKey);
        try { engine.shutdown?.(); } catch { /* best-effort */ }
        throw new Error('no inference engine reachable on this node (Ollama/vLLM/llama.cpp did not answer); refusing to serve stub output');
    }
    return engine;
}

/** Best-effort: does Ollama (at host) currently serve this exact tag? */
async function ollamaHasModel(modelName, host) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 800);
        const r = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) return false;
        const data = await r.json();
        return (data.models ?? []).some((m) => m.name === modelName || m.model === modelName);
    } catch {
        return false;
    }
}

async function getEngineForModel(modelName) {
    // vLLM is the default serving path. Route PER MODEL so both engines coexist:
    //   1. vLLM is serving this model  → vLLM (preferred, high throughput)
    //   2. Ollama has this GGUF tag    → Ollama (its library keeps working even
    //                                     while vLLM is up serving another model)
    //   3. otherwise                   → default (auto-select, which prefers vLLM)
    if (modelName) {
        try {
            const { detectVllmModels, VLLM_HOST } = await import('./vllm.js');
            const vModels = await detectVllmModels();
            if (vModels.includes(modelName)) {
                return buildEngine('vllm', { backend: 'vllm', host: VLLM_HOST, defaultModel: modelName });
            }
        } catch {
            // vLLM module/probe failed — try Ollama, then the default.
        }
        const config = (await loadConfig().catch(() => null)) ?? {};
        const ollamaHost = config.engine?.ollamaHost ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
        if (await ollamaHasModel(modelName, ollamaHost)) {
            return buildEngine('ollama', { backend: 'ollama', host: ollamaHost, defaultModel: modelName });
        }
    }
    return defaultEngine();
}

export async function shutdownEngine() {
    const engines = [...engineCache.values()];
    engineCache.clear();
    await Promise.all(engines.map(async (p) => {
        try { (await p).shutdown(); } catch { /* best-effort */ }
    }));
}

/**
 * Run the chat executor for one job.
 *
 * @param {{ client: any, job: any, node: any }} ctx
 * @returns {Promise<{ text: string, token_count: number, duration_ms: number }>}
 *   Full assistant response + token count + wall-clock duration.
 *   Caller (start.js) uses these to maintain a rolling tokens-per-second
 *   benchmark advertised via heartbeat → enables speed-aware routing.
 */
export async function executeChatJob({ client, job, node }) {
    const input = job?.input_spec ?? {};

    // IPIP-0027: if the job carries NIP-44 encrypted messages, decrypt them
    // using our node privkey + the consumer's pubkey. Falls back to plaintext
    // messages for legacy (unencrypted) jobs.
    let messages = input.messages ?? [];
    let convKey = null;
    if (input.encrypted_messages && job.client_pubkey) {
        // IPIP-0028: prefer model-specific key; fall back to node key (IPIP-0027).
        const modelKP = job.model_name ? await getModelKeyPair(job.model_name) : null;
        const decryptPrivKey = modelKP?.privateKey ?? node.privateKey ?? null;
        if (!decryptPrivKey) {
            throw new Error("No private key available to decrypt E2E messages");
        }
        try {
            convKey = getConversationKey(decryptPrivKey, job.client_pubkey);
            const plainJson = decrypt(convKey, input.encrypted_messages);
            messages = JSON.parse(plainJson);
        } catch (err) {
            process.stderr.write(`nip44 decrypt failed: ${err?.message ?? err}\n`);
            throw new Error("Failed to decrypt E2E messages — key mismatch or corrupted payload");
        }
    }

    const engine = await getEngineForModel(job.model_name);
    const buffer = new EventBuffer(client, job.id, convKey);

    const t0 = Date.now();
    const generation = engine.generate({
        messages,
        model: job.model_name ?? null,
        max_tokens: input.max_tokens,
        temperature: input.temperature
    });

    let accumulated = "";
    let tokenCount = 0;

    for await (const ev of generation.stream) {
        switch (ev.type) {
            case MSG.META:
                await buffer.push("meta", {
                    provider_node_id: node.nodeId,
                    provider_name: node.name ?? null,
                    model: ev.model ?? job.model_name ?? null,
                    started_at: ev.started_at ?? new Date().toISOString(),
                    engine: engine.kind
                });
                break;
            case MSG.TOKEN:
                accumulated += ev.text ?? "";
                tokenCount += 1;
                await buffer.push("token", { text: ev.text ?? "" });
                break;
            case MSG.DONE:
                if (typeof ev.text === "string" && ev.text.length > accumulated.length) {
                    accumulated = ev.text;
                }
                await buffer.push("done", {
                    text: accumulated,
                    reason: ev.reason ?? "stop",
                    finished_at: ev.finished_at ?? new Date().toISOString()
                });
                break;
            case MSG.ERROR:
                await buffer.push("error", { message: ev.message ?? "engine error" });
                await buffer.flush();
                throw new Error(ev.message ?? "engine error");
            default:
                // forward unknown event types verbatim — useful for backend
                // extensions (logits, tool_call, etc.) once the protocol grows.
                await buffer.push(ev.type, ev);
        }
    }

    await buffer.flush();
    const duration_ms = Date.now() - t0;
    return { text: accumulated, token_count: tokenCount, duration_ms, e2e: Boolean(convKey) };
}

export async function failChatJob({ client, jobId, message }) {
    try {
        await client.postJobEvents(jobId, [{ event_type: "error", data: { message } }]);
    } catch {
        // Non-fatal; the job row still gets marked 'failed' by the caller.
    }
}
