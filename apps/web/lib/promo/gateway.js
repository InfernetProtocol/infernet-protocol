import "server-only";

// The c0mpute speech gateway calls a promo makes, through the same gateway
// (C0MPUTE_SPEECH_URL) as /image, /music and voice: keyframes on diffusion
// workers, narration on TTS workers, the soundtrack on music workers and
// img2vid clips on video workers.

import { fetchSpeechGateway, postSpeechGatewayLong } from "@/lib/chat/speech-service";
import { describeNodeProgress } from "@/lib/billing/music";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(what, response) {
  let message = "";
  try {
    message = JSON.parse(response.body.toString("utf8"))?.error ?? "";
  } catch { /* not JSON */ }
  return Object.assign(new Error(`${what} failed (gateway HTTP ${response.status})${message ? `: ${message}` : ""}`), { status: response.status });
}

async function post(path, body, timeoutMs, headers) {
  const response = await postSpeechGatewayLong(path, body, { timeoutMs, headers });
  if (!response) throw Object.assign(new Error("The c0mpute gateway is not configured"), { status: 503 });
  return response;
}

export async function image(spec) {
  const r = await post("/v1/images", spec, 15 * 60 * 1000);
  if (r.status === 200) return r.body;
  throw fail("image", r);
}

export async function tts(spec) {
  const r = await post("/v1/tts", spec, 4 * 60 * 1000);
  if (r.status === 200) return r.body;
  throw fail("narration", r);
}

export async function video(spec) {
  const r = await post("/v1/videos", spec, 50 * 60 * 1000);
  if (r.status === 200 && /video\/mp4/.test(String(r.headers["content-type"] ?? ""))) return r.body;
  throw fail("img2vid", r);
}

/** The soundtrack, with the gateway's live node progress relayed as one line. */
export async function music(spec, { requestId = null, onProgress = null } = {}) {
  let stopped = false;
  if (requestId && onProgress) {
    (async () => {
      while (!stopped) {
        await sleep(5000);
        if (stopped) break;
        try {
          const res = await fetchSpeechGateway(`/v1/progress/${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(4000) });
          if (res?.ok) {
            const p = await res.json().catch(() => null);
            if (!stopped && p?.stage) onProgress(describeNodeProgress(p));
          }
        } catch { /* best effort */ }
      }
    })();
  }
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await post("/v1/music", spec, 25 * 60 * 1000, requestId ? { "x-request-id": requestId } : {});
        if (r.status === 200) {
          const type = String(r.headers["content-type"] ?? "audio/mpeg").split(";")[0].trim();
          return { bytes: r.body, type };
        }
        if (r.status !== 503 || attempt === 2) throw fail("music", r);
      } catch (e) {
        if (attempt === 2 || (e?.status && e.status !== 503)) throw e;
      }
      await sleep(10_000);
    }
  } finally {
    stopped = true;
  }
  throw new Error("music failed");
}

export const promoGateway = { image, tts, video, music };
