import "server-only";

// The c0mpute speech gateway calls a promo makes, through the same gateway
// (C0MPUTE_SPEECH_URL) as /image, /music and voice: keyframes on diffusion
// workers, narration on TTS workers, the soundtrack on music workers and
// img2vid clips on video workers.

import { randomUUID } from "node:crypto";
import { postSpeechGatewayLong, runGatewayJob } from "@/lib/chat/speech-service";
import { describeNodeProgress } from "@/lib/billing/music";

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

// Images, clips and the soundtrack wait in the gateway's queue for a free
// worker (up to 2 h) instead of failing, keep their request id across a
// deploy (resume collects what the gateway kept), and are never posted twice
// while the gateway has them.

export async function image(spec, { requestId = null, resume = false } = {}) {
  const r = await runGatewayJob("/v1/images", spec, { requestId: requestId ?? randomUUID(), resume });
  if (r.status === 200) return r.body;
  throw fail("image", r);
}

export async function tts(spec) {
  const r = await post("/v1/tts", spec, 4 * 60 * 1000);
  if (r.status === 200) return r.body;
  throw fail("narration", r);
}

/**
 * A motion clip. Optional: the pipeline gives motion a budget and shows a
 * still for any clip not back by then, so the gateway is told to stop
 * queueing it at the same point (`maxWaitS`) rather than hold it 2 h.
 */
export async function video(spec, { requestId = null, resume = false, maxWaitS = null } = {}) {
  const r = await runGatewayJob("/v1/videos", spec, { requestId: requestId ?? randomUUID(), resume, maxWaitS });
  if (r.status === 200 && /video\/mp4/.test(String(r.headers["content-type"] ?? ""))) return r.body;
  throw fail("img2vid", r);
}

/** The soundtrack, with the gateway's live node progress relayed as one line. */
export async function music(spec, { requestId = null, onProgress = null, resume = false } = {}) {
  const r = await runGatewayJob("/v1/music", spec, {
    requestId: requestId ?? randomUUID(),
    resume,
    onProgress: onProgress ? (p) => onProgress(describeNodeProgress(p)) : null
  });
  if (r.status !== 200) throw fail("music", r);
  const type = String(r.headers["content-type"] ?? "audio/mpeg").split(";")[0].trim();
  return { bytes: r.body, type };
}

export const promoGateway = { image, tts, video, music };
