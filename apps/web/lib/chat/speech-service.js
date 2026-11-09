import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export function speechGateway() {
  const baseUrl = process.env.C0MPUTE_SPEECH_URL?.trim().replace(/\/+$/, "");
  const token = process.env.C0MPUTE_SPEECH_TOKEN;
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

export function errorJson(error, status, detail) {
  return Response.json({ error, ...(detail ? { detail } : {}) }, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

export async function fetchSpeechGateway(path, init = {}) {
  const service = speechGateway();
  if (!service) return null;
  return fetch(`${service.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${service.token}`,
      ...(init.headers ?? {})
    },
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(5 * 60 * 1000)
  });
}

export async function readLimitedBody(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * POST JSON to the gateway and read the whole body, with NO header timeout.
 *
 * Node's fetch (undici) aborts any response whose headers take longer than
 * 300 s ("fetch failed"), and a CPU image on a busy c0mpute worker can take
 * longer. node:http waits as long as `timeoutMs`.
 * Resolves { status, headers, body: Buffer } or null when unconfigured.
 */
export async function postSpeechGatewayLong(path, payload, { timeoutMs = 14 * 60 * 1000, headers: extraHeaders = {} } = {}) {
  const service = speechGateway();
  if (!service) return null;
  const url = new URL(`${service.baseUrl}${path}`);
  // Static imports: Next cannot bundle a computed import() specifier.
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
          ...extraHeaders,
          authorization: `Bearer ${service.token}`,
          "content-type": "application/json",
          "content-length": body.length
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`gateway did not answer within ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Wait for a request the gateway is still running detached (c0mpute >=
 * 0.2.90): poll GET /v1/result/<id> until it is done. Resolves the same
 * { status, headers, body } shape as postSpeechGatewayLong, or null when the
 * gateway does not know the request (older gateway, or it never started).
 */
export async function awaitGatewayResult(requestId, { timeoutMs = 30 * 60 * 1000, everyMs = 10_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let res;
    try {
      res = await fetchSpeechGateway(`/v1/result/${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(60_000) });
    } catch {
      await new Promise((r) => setTimeout(r, everyMs));
      continue;
    }
    if (!res) return null;
    if (res.status === 404) return null;
    if (res.status === 202) {
      await res.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, everyMs));
      continue;
    }
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  }
  return null;
}

/**
 * How long a c0mpute gateway keeps a job queued for a worker before giving up
 * (c0mpute >= 0.2.99 queues instead of failing fast; 2 h by default), plus
 * time for the render itself. Every caller that waits on a gateway job must
 * allow at least this, or it fails a job the gateway is still going to serve.
 */
export const GATEWAY_QUEUE_WAIT_MS = Number(process.env.C0MPUTE_QUEUE_WAIT_MS) || 2 * 60 * 60 * 1000;
export const GATEWAY_JOB_LIMIT_MS = GATEWAY_QUEUE_WAIT_MS + 45 * 60 * 1000;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one long gateway job (image, song, clip) to its end and resolve
 * { status, headers, body } like postSpeechGatewayLong.
 *
 * The request carries `x-request-id` and `Prefer: wait=60`: a gateway that
 * has a worker answers with the result; one that is queueing the job answers
 * 202 within a minute and we poll GET /v1/result/<id> until it is served or
 * the gateway's own max wait runs out (it then answers 503 "no worker for
 * <workload>/<model> within 2h"). We never post the same job twice while the
 * gateway knows it, so a queued job costs no retries and no second charge;
 * it is posted again only when the gateway lost it (404, or the connection
 * dropped and it never saw the id). Older gateways ignore Prefer and answer
 * synchronously, which is handled the same way.
 */
export async function runGatewayJob(path, spec, { requestId, timeoutMs = GATEWAY_JOB_LIMIT_MS, onProgress = null, resume = false, attempts = 3, pollMs = 10_000, maxWaitS = null } = {}) {
  if (!requestId) throw new Error("runGatewayJob needs a request id");
  const until = Date.now() + timeoutMs;
  let stopped = false;
  if (onProgress) {
    (async () => {
      while (!stopped) {
        await sleepMs(5000);
        if (stopped) break;
        try {
          const res = await fetchSpeechGateway(`/v1/progress/${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(4000) });
          if (res?.ok) {
            const p = await res.json().catch(() => null);
            if (!stopped && p && typeof p.stage === "string") onProgress(p);
          } else {
            await res?.body?.cancel().catch(() => {});
          }
        } catch { /* best effort */ }
      }
    })();
  }
  const wait = () => awaitGatewayResult(requestId, { timeoutMs: Math.max(0, until - Date.now()), everyMs: pollMs });
  try {
    if (resume) {
      const kept = await wait().catch(() => null);
      if (kept) return kept;
    }
    let lastError = null;
    for (let i = 1; i <= attempts && Date.now() < until; i++) {
      let response;
      try {
        response = await postSpeechGatewayLong(path, spec, {
          timeoutMs: Math.max(60_000, until - Date.now()),
          headers: { "x-request-id": requestId, prefer: "wait=60", ...(maxWaitS ? { "x-max-wait": String(Math.round(maxWaitS)) } : {}) }
        });
      } catch (error) {
        lastError = error;
        // The connection dropped (the gateway restarting into an update): it
        // kept the job under our id if it saw it; wait for that.
        const kept = await wait().catch(() => null);
        if (kept) return kept;
        await sleepMs(i * 5000);
        continue;
      }
      if (!response) throw Object.assign(new Error("The c0mpute gateway is not configured"), { status: 503 });
      if (response.status !== 202) return response;
      const done = await wait();
      if (done) return done;
      // 404: the gateway forgot the job (a data loss, not a queue): post again.
    }
    throw Object.assign(new Error(`gateway job ${requestId} did not finish: ${lastError?.message ?? "timed out"}`), { status: 504 });
  } finally {
    stopped = true;
  }
}

/** The gateway's error message from a non-200 response body, if any. */
export function gatewayError(response) {
  try {
    return JSON.parse(Buffer.from(response.body).toString("utf8"))?.error ?? "";
  } catch {
    return "";
  }
}
