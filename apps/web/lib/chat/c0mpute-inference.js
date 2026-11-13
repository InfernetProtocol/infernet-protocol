// LLM chat on c0mpute workers (workload `infernet.inference`).
//
// c0mpute workers answer chat completions peer to peer from their own Ollama
// or llama-server. They advertise `infernet:inference` plus one
// `infernet:inference:model:<id>` tag per model, and c0mpute.com/api/status
// counts them in network.workers_with_tag.
//
// Infernet reaches them through a c0mpute jobs bridge (`c0mpute jobs serve`,
// DIP-0030): POST /v1/jobs {workload:"infernet.inference", spec} runs one
// auction, waits for the winner's receipt, fetches the answer by its hash and
// checks it. Answers are one-shot: no token streaming across the network yet.
//
// Feature check: C0MPUTE_JOBS_URL + C0MPUTE_JOBS_TOKEN. Without both, nothing
// here is used and chat routes exactly as before.
//
// Privacy: the winning worker reads the prompt (the bridge seals it to that one
// worker, not to the network). E2E chat never comes here.

export const WORKLOAD = "infernet.inference";
export const ROLE_TAG = "infernet:inference";
const MODEL_TAG_PREFIX = `${ROLE_TAG}:model:`;

// Spec limits enforced by c0mpute-core/src/inference.rs (parse_spec).
export const MAX_MESSAGES = 64;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_TOKENS = 4096;
const MODEL_ID_RE = /^[A-Za-z0-9\-_.:/@]{1,128}$/;

const STATUS_URL = () => process.env.C0MPUTE_STATUS_URL || "https://c0mpute.com/api/status";
const STATUS_TTL_MS = 30_000;
// The bridge's own ceiling is 300 s. A CPU worker on a 7B model can need a
// couple of minutes for a long answer; stay well under undici's 300 s header
// timeout too.
export const DEFAULT_TIMEOUT_MS = 180_000;

/** The configured jobs bridge, or null when the feature is off. */
export function c0mputeJobsBridge(env = process.env) {
  const baseUrl = env.C0MPUTE_JOBS_URL?.trim().replace(/\/+$/, "");
  const token = env.C0MPUTE_JOBS_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

/**
 * Workers serving infernet.inference from c0mpute's GET /api/status body:
 * { workers, models: { "<model id>": <worker count> } }, or null when the
 * body is not that shape (c0mpute.com answers some outages with an HTML 200).
 */
export function summarizeC0mputeInference(body) {
  const tags = body?.network?.workers_with_tag;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return null;
  const models = {};
  for (const [tag, count] of Object.entries(tags)) {
    if (!tag.startsWith(MODEL_TAG_PREFIX)) continue;
    const id = tag.slice(MODEL_TAG_PREFIX.length);
    const n = Number(count);
    if (id && Number.isFinite(n) && n > 0) models[id] = n;
  }
  const workers = Number(tags[ROLE_TAG]);
  return { workers: Number.isFinite(workers) && workers > 0 ? workers : 0, models };
}

let cache = { at: 0, value: null };

/** Live infernet.inference summary (30 s cache), or null when unreachable. */
export async function fetchC0mputeInference({ fetchImpl = fetch, timeoutMs = 4000, now = Date.now() } = {}) {
  if (cache.value && now - cache.at < STATUS_TTL_MS) return cache.value;
  try {
    const res = await fetchImpl(STATUS_URL(), {
      headers: { accept: "application/json", "user-agent": "infernet-web" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store"
    });
    if (!res.ok) return cache.value;
    const summary = summarizeC0mputeInference(await res.json());
    if (summary) cache = { at: now, value: summary };
    return summary ?? cache.value;
  } catch {
    // A stale answer beats none: the network does not vanish in 30 s.
    return cache.value;
  }
}

/** Test hook. */
export function resetC0mputeInferenceCache() {
  cache = { at: 0, value: null };
}

/** Model ids c0mpute workers serve right now (empty when the feature is off). */
export async function c0mputeChatModels(deps = {}) {
  if (!c0mputeJobsBridge(deps.env)) return [];
  const summary = await fetchC0mputeInference(deps);
  return summary ? Object.keys(summary.models).sort() : [];
}

/**
 * Fit chat messages to the worker's spec rules: only system/user/assistant
 * string turns, at most 64 of them and 64 KiB of text (oldest non-system turns
 * dropped first), never ending on an assistant turn. Null when nothing is left.
 */
export function fitMessages(messages) {
  let turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content }));
  while (turns.length && turns[turns.length - 1].role === "assistant") turns.pop();
  const bytes = (list) => list.reduce((n, m) => n + Buffer.byteLength(m.content, "utf8"), 0);
  while (turns.length > 1 && (turns.length > MAX_MESSAGES || bytes(turns) > MAX_PROMPT_BYTES)) {
    const drop = turns.findIndex((m, i) => m.role !== "system" && i < turns.length - 1);
    if (drop < 0) break;
    turns.splice(drop, 1);
  }
  if (turns.length === 0 || turns.length > MAX_MESSAGES || bytes(turns) > MAX_PROMPT_BYTES) return null;
  return turns;
}

/** The infernet.inference spec for one chat turn, or null if it cannot be one. */
export function buildSpec({ model, messages, maxTokens, temperature }) {
  const fitted = fitMessages(messages);
  if (!fitted) return null;
  const spec = { v: 1, messages: fitted };
  if (typeof model === "string" && MODEL_ID_RE.test(model)) spec.model = model;
  const t = Number(maxTokens);
  if (Number.isFinite(t) && t >= 1) spec.max_tokens = Math.min(MAX_TOKENS, Math.floor(t));
  const temp = Number(temperature);
  if (temperature != null && Number.isFinite(temp)) spec.temperature = Math.min(2, Math.max(0, temp));
  return spec;
}

const BRIDGE_ERRORS = {
  no_bids: "no c0mpute worker took the request",
  timeout: "the c0mpute worker did not answer in time",
  worker_failed: "the c0mpute worker failed",
  unknown_workload: "the c0mpute jobs bridge is too old for chat (needs c0mpute >= 0.3)",
  unauthorized: "the c0mpute jobs bridge refused our token"
};

/**
 * Run one chat turn on a c0mpute worker. Never throws:
 * { ok: true, text, model, worker, jobId, price, durationMs } or
 * { ok: false, error, code, status }.
 */
export async function runC0mputeChat({ model, messages, maxTokens, temperature, timeoutMs = DEFAULT_TIMEOUT_MS }, { fetchImpl = fetch, env } = {}) {
  const bridge = c0mputeJobsBridge(env);
  if (!bridge) return { ok: false, code: "off", error: "c0mpute chat is not configured" };
  const spec = buildSpec({ model, messages, maxTokens, temperature });
  if (!spec) return { ok: false, code: "bad_request", error: "nothing to send: no user message" };
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(`${bridge.baseUrl}/v1/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ workload: WORKLOAD, spec, timeout_ms: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10_000),
      cache: "no-store"
    });
  } catch (e) {
    return { ok: false, code: "unreachable", error: `c0mpute jobs bridge unreachable: ${e?.message ?? e}` };
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
    const detail = typeof body?.detail === "string" ? ` (${body.detail})` : "";
    return { ok: false, code, status: res.status, error: `${BRIDGE_ERRORS[code] ?? `c0mpute jobs bridge answered ${res.status}`}${detail}` };
  }
  const result = body?.result;
  if (result?.ok !== true || typeof result.text !== "string") {
    return { ok: false, code: "worker_failed", status: 502, error: `the c0mpute worker could not answer: ${result?.error ?? "malformed result"}` };
  }
  return {
    ok: true,
    text: result.text,
    model: typeof result.model === "string" ? result.model : (spec.model ?? null),
    worker: typeof body.worker === "string" ? body.worker : null,
    jobId: typeof body.job_id === "string" ? body.job_id : null,
    price: Number.isFinite(body.price) ? body.price : null,
    durationMs: Date.now() - started
  };
}

/** What the chat routes show for a c0mpute-served job (like nimVirtualProvider). */
export function c0mputeVirtualProvider(model) {
  return {
    id: null,
    name: "c0mpute network",
    node_id: "c0mpute",
    gpu_model: null,
    model: model ?? null,
    public_key: null
  };
}

/**
 * Serve a job created with input_spec.fallback === "c0mpute". Yields the same
 * normalized events as the other paths ({ type: meta|token|done|error, data, id })
 * and persists them through the injected helpers. When the worker cannot
 * answer it yields { type: "c0mpute_failed", data: { message } } WITHOUT
 * persisting an error, so the caller can still hand the job to the hosted
 * fallback (input_spec.nim_ok) before anything else is shown.
 */
export async function* c0mputeJobEvents(job, { run = runC0mputeChat, insertEvent, finalize, charge, log = console.log }) {
  const input = job.input_spec ?? {};
  const model = input.c0mpute_model ?? job.model_name ?? null;
  const meta = {
    provider_node_id: "c0mpute",
    provider_name: "c0mpute network",
    engine: "c0mpute:infernet.inference",
    model,
    started_at: new Date().toISOString()
  };
  const persistedMeta = await insertEvent(job.id, "meta", meta);
  yield { type: "meta", data: persistedMeta?.data ?? meta, id: persistedMeta?.id };

  const out = await run({ model, messages: input.messages ?? [], maxTokens: input.max_tokens, temperature: input.temperature });
  if (!out.ok) {
    log(`[c0mpute-chat] job ${job.id} model=${model} failed: ${out.error}`);
    yield { type: "c0mpute_failed", data: { message: out.error, code: out.code } };
    return;
  }
  log(`[c0mpute-chat] job ${job.id} model=${out.model} worker=${out.worker} c0mpute_job=${out.jobId} price=${out.price} ${out.durationMs}ms`);
  const token = { text: out.text };
  const persistedToken = await insertEvent(job.id, "token", token);
  yield { type: "token", data: token, id: persistedToken?.id };
  const done = {
    text: out.text,
    finished_at: new Date().toISOString(),
    source: "c0mpute",
    worker: out.worker,
    c0mpute_job_id: out.jobId,
    model: out.model
  };
  const persistedDone = await insertEvent(job.id, "done", done);
  const result = { type: "chat", text: out.text, source: "c0mpute", worker: out.worker, c0mpute_job_id: out.jobId, model: out.model };
  await finalize(job.id, { status: "completed", result });
  await charge(job, result);
  yield { type: "done", data: done, id: persistedDone?.id };
}
