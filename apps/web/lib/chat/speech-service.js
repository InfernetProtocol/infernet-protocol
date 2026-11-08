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
export async function postSpeechGatewayLong(path, payload, { timeoutMs = 14 * 60 * 1000 } = {}) {
  const service = speechGateway();
  if (!service) return null;
  const url = new URL(`${service.baseUrl}${path}`);
  const { request } = await import(url.protocol === "https:" ? "node:https" : "node:http");
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: {
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
