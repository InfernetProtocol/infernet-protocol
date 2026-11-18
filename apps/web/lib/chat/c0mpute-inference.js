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

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { maxRequeues as defaultMaxRequeues, NETWORK_BUSY_MESSAGE, RUN_A_NODE_URL } from "../routing/requeue.js";

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
// Every live worker is a CPU node: a 1k-token agent turn on a 7B-9B model
// takes 3-5 min (bids say eta_s 218-301). At 180 s the bridge gave up on
// answers that landed a minute later, then the job ran AGAIN on a provider
// daemon on the same box, so the backlog grew and nothing answered (moshcode
// `agents c0mpute`, 2026-11-14). 7 min leaves a 10 min client (moshcode) room
// for the provider fallback. Needs a bridge that allows it (c0mpute >= the
// release raising MAX_TIMEOUT_MS past 300 s; older bridges clamp to 300 s) and
// node:http (undici fetch dies at 300 s waiting for headers).
export const DEFAULT_TIMEOUT_MS = 420_000;

// The most a chat may spend in the queue, from job creation, besides the
// requeue cap (c0mputeJobEvents). 9 min leaves a 10 min client (moshcode)
// time to read the error. INFERNET_C0MPUTE_WAIT_MS.
export const DEFAULT_WAIT_MS = 540_000;
// Below this much time left, another bridge attempt cannot finish.
export const MIN_ATTEMPT_MS = 20_000;
// A requeued job's wait window: up to this long at the back of the queue for
// a node or worker with a free slot (a GPU frees one every ~20-90 s), asking
// again every REQUEUE_POLL_MS; a try counts as used only when its window ends
// with no taker. INFERNET_REQUEUE_WAIT_MS.
export const DEFAULT_REQUEUE_WAIT_MS = 90_000;
export const REQUEUE_POLL_MS = 5_000;

/** INFERNET_REQUEUE_WAIT_MS, else DEFAULT_REQUEUE_WAIT_MS. */
export function requeueWaitMs(env = process.env) {
  const n = Number.parseInt(env?.INFERNET_REQUEUE_WAIT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REQUEUE_WAIT_MS;
}
// Bridge answers that mean "busy, try again", not "cannot serve this"
// (see isRetryable for worker_failed).
export const RETRYABLE_CODES = new Set([
  "no_bids", "timeout", "busy", "queued", "waiting", "capacity", "worker_busy", "unreachable", "http_429", "http_502", "http_503", "http_504"
]);

// A worker that took the job but whose runtime was busy or slow to answer
// ("reach the local runtime: ... operation timed out", 2026-11-18): busy too.
const WORKER_BUSY_RE = /timed? ?out|busy|reach the local runtime|too many requests|\b(?:429|503)\b|queue/i;

/** Is this bridge answer "busy, try again"? */
export function isRetryable(out) {
  if (!out || out.ok) return false;
  if (RETRYABLE_CODES.has(out.code)) return true;
  return out.code === "worker_failed" && WORKER_BUSY_RE.test(String(out.error ?? ""));
}

/** Total wait budget (ms) from INFERNET_C0MPUTE_WAIT_MS, else DEFAULT_WAIT_MS. */
export function c0mputeWaitMs(env = process.env) {
  const n = Number.parseInt(env.INFERNET_C0MPUTE_WAIT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WAIT_MS;
}

/**
 * Does any c0mpute worker serve `model`? true / false, or null when the
 * network status is unknown (unknown is treated as capable: an outage of the
 * status page must not send every chat to a CPU node).
 */
export async function c0mputeServesModel(model, deps = {}) {
  const summary = await fetchC0mputeInference(deps);
  if (!summary) return null;
  if (!model) return summary.workers > 0;
  const ids = Object.keys(summary.models);
  if (ids.length === 0) return summary.workers > 0 ? null : false;
  const { matchServedModel } = await import("@/lib/model-names");
  return matchServedModel(ids, model) !== null;
}

/**
 * POST to the bridge with node:http: a fetch-shaped { ok, status, json() } with
 * no header timeout, so a job longer than undici's 300 s still answers.
 * `init.signal` ends it.
 */
export function bridgeFetch(url, init = {}) {
  const u = new URL(url);
  const request = u.protocol === "https:" ? httpsRequest : httpRequest;
  const body = init.body == null ? null : Buffer.from(init.body);
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: init.method ?? "GET",
        headers: { ...(init.headers ?? {}), ...(body ? { "content-length": body.length } : {}) },
        signal: init.signal
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text });
        });
      }
    );
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

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
export async function runC0mputeChat({ model, messages, maxTokens, temperature, timeoutMs = DEFAULT_TIMEOUT_MS }, { fetchImpl = bridgeFetch, env } = {}) {
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
    const position = Number(body?.queue_position ?? body?.position);
    return {
      ok: false, code, status: res.status,
      error: `${BRIDGE_ERRORS[code] ?? `c0mpute jobs bridge answered ${res.status}`}${detail}`,
      ...(Number.isFinite(position) && position >= 0 ? { queuePosition: position } : {})
    };
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

/**
 * The terminal `error` event for a chat the queue gave up on: the message
 * (exactly "Network is busy. Run a node or wait." when out of requeues), its
 * code, and where running a node is explained.
 */
export function c0mputeErrorData(failed = {}) {
  const message = failed?.message ?? "c0mpute worker failed";
  const data = { message };
  if (failed?.code) data.code = failed.code === "too_many_requeues" || failed.code === "wait_budget" ? "network_busy" : failed.code;
  if (message === NETWORK_BUSY_MESSAGE) data.run_a_node = RUN_A_NODE_URL;
  return data;
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
 * The line of chats waiting on c0mpute in this process, per model, ordered by
 * when each (re)joined: a turned-away job rejoins at the BACK. It only gives
 * each waiting chat its position for the status event; nobody waits for the
 * head (no head-of-line blocking: every job retries on its own clock).
 */
export function createWaitQueue() {
  const waiting = new Map();
  let seq = 0;
  return {
    /** Join at the back (or move to the back); returns the 0-based position. */
    join(model, id) {
      const key = model ?? "";
      if (!waiting.has(key)) waiting.set(key, []);
      const list = waiting.get(key);
      const i = list.findIndex((e) => e.id === id);
      if (i >= 0) list.splice(i, 1);
      list.push({ id, seq: seq++ });
      return list.length - 1;
    },
    position(model, id) {
      return (waiting.get(model ?? "") ?? []).findIndex((e) => e.id === id);
    },
    leave(model, id) {
      const key = model ?? "";
      const list = waiting.get(key);
      if (!list) return;
      const i = list.findIndex((e) => e.id === id);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) waiting.delete(key);
    }
  };
}

const sharedWaitQueue = createWaitQueue();

/**
 * Serve a job created with input_spec.fallback === "c0mpute". Yields the same
 * normalized events as the other paths ({ type: meta|status|token|done|error,
 * data, id }) and persists them through the injected helpers.
 *
 * The queue (Anthony, 2026-11-18): a job is dispatched to the first capable
 * node with a free slot, the c0mpute auction (the bridge picks a free worker,
 * GPU or CPU), else an Infernet provider daemon with a free slot serving the
 * model (`assign({ freeSlot: true })`, the fastest free one). Turned away, a
 * busy or failed worker or a timeout: back in the queue at the BACK ("just
 * add it to the back of the queue"), with a `status` event ({ state:
 * "waiting", message, queue_position, requeues, max_requeues, wait_ms }), and
 * a real wait: up to INFERNET_REQUEUE_WAIT_MS (90 s) asking every few seconds
 * for a daemon with a free slot or a c0mpute worker that bids, dispatched as
 * soon as one does. A try counts as used only when its window ends with no
 * taker. Nothing hands the job straight to a busy node.
 *
 * Guards against looping forever:
 *   - no node serves the model at all (no c0mpute worker, no daemon): fail at
 *     once ("No node serves <model>.");
 *   - after INFERNET_MAX_REQUEUES (3) wait windows with no node taking it
 *     (worst case ~3 x 90 s), or at
 *     the wait budget (INFERNET_C0MPUTE_WAIT_MS): end with "Network is busy.
 *     Run a node or wait." ("if there's no nodes available after 3 queues
 *     tell the user and end");
 *   - no head-of-line blocking: other jobs keep dispatching.
 *
 * When no c0mpute worker serves the model but a daemon does, the job is
 * assigned to the best daemon serving it (`assign({ freeSlot: false })`).
 *
 * Yields { type: "assigned", job } when a daemon took it (the caller then
 * streams the provider path, same job id), or { type: "c0mpute_failed",
 * data: { message, code, capable, final } } (nothing persisted) when it gave
 * up; `final` means tell the caller `message` and end (no other fallback).
 */
export async function* c0mputeJobEvents(job, {
  run = runC0mputeChat,
  insertEvent,
  finalize,
  charge,
  assign = async () => null,
  log = console.log,
  serves = c0mputeServesModel,
  waitMs = c0mputeWaitMs(),
  maxRequeues = defaultMaxRequeues(),
  windowMs = requeueWaitMs(),
  pollMs = REQUEUE_POLL_MS,
  queue = sharedWaitQueue,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
}) {
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

  const createdAt = Date.parse(job.created_at ?? "") || now();
  const deadline = createdAt + waitMs;
  const busy = (code) => ({ ok: false, code, final: true, error: NETWORK_BUSY_MESSAGE });
  const attempt = async (n) => {
    const timeoutMs = Math.max(MIN_ATTEMPT_MS, Math.min(DEFAULT_TIMEOUT_MS, deadline - now()));
    const r = await run({ model, messages: input.messages ?? [], maxTokens: input.max_tokens, temperature: input.temperature, timeoutMs });
    if (!r.ok) log(`[c0mpute-chat] job ${job.id} model=${model} attempt ${n}: ${r.error}`);
    return r;
  };
  const turnedAway = (r) => isRetryable(r) || r.code === "worker_failed";
  let attempts = 1;
  let out = await attempt(attempts);
  let capable = null;
  let requeues = 0;
  try {
    outer: while (!out.ok && turnedAway(out)) {
      capable = await serves(model).catch(() => null);
      if (capable === false) {
        // No c0mpute worker serves it: a daemon serving it, or nothing does.
        const moved = await assign({ freeSlot: false }).catch(() => null);
        if (moved) { yield { type: "assigned", job: moved }; return; }
        out = { ok: false, code: "no_capable_node", final: true, error: `No node serves ${model ?? "this model"}.` };
        break;
      }
      // A daemon with a free slot right now (CPU included) takes it at once.
      const freeNow = await assign({ freeSlot: true }).catch(() => null);
      if (freeNow) { yield { type: "assigned", job: freeNow }; return; }
      if (requeues >= maxRequeues) { out = busy("too_many_requeues"); break; }
      if (deadline - now() < MIN_ATTEMPT_MS) { out = busy("wait_budget"); break; }

      // Back of the queue, and a real wait: up to windowMs for a capable
      // node or worker with a free slot, asking every pollMs.
      requeues += 1;
      const position = out.queuePosition ?? queue.join(model, job.id);
      if (out.queuePosition != null) queue.join(model, job.id);
      const windowEnd = Math.min(now() + windowMs, deadline - MIN_ATTEMPT_MS);
      const status = {
        state: "waiting",
        route: "queue",
        message: `no free node; waiting in the queue (position ${position + 1}, try ${requeues} of ${maxRequeues})`,
        queue_position: position,
        requeues,
        max_requeues: maxRequeues,
        wait_ms: Math.max(0, windowEnd - now()),
        waited_ms: now() - createdAt,
        reason: out.code
      };
      const persisted = await insertEvent(job.id, "status", status);
      yield { type: "status", data: persisted?.data ?? status, id: persisted?.id };

      while (now() < windowEnd) {
        await sleep(Math.max(0, Math.min(pollMs, windowEnd - now())));
        // The first capable node with a free slot: a daemon (CPU included)...
        const moved = await assign({ freeSlot: true }).catch(() => null);
        if (moved) { yield { type: "assigned", job: moved }; return; }
        // ...or a c0mpute worker that bids now.
        attempts += 1;
        out = await attempt(attempts);
        if (out.ok) break outer;
        if (!turnedAway(out)) break outer;
      }
      // The window ended with no taker: that try is used.
    }
  } finally {
    queue.leave(model, job.id);
  }
  if (!out.ok) {
    if (capable === null && isRetryable(out)) capable = await serves(model).catch(() => null);
    yield { type: "c0mpute_failed", data: { message: out.error, code: out.code, capable, final: out.final === true } };
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
