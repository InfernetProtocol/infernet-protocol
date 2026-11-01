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
