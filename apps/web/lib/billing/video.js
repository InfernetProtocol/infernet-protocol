// Video generation on c0mpute (video.txt2vid) for trusted clients such as
// c0mpute.com's /api/v1/videos. Pure helpers: request validation, the flat
// per-clip (per-shot) price and the adult rule.
//
// The default is a 30 s clip on Wan 2.2 5B (GPU), cut from 5 s shots (see
// lib/video/shots.js). Wan 2.1 1.3B (CPU) stays as a quick ~2 s draft.

import { DEFAULT_CLIP_SECONDS, SHOT_MODELS, clampSeconds, secondsFromPrompt, shotCount, singleShotPrompts, subjectOf } from "../video/shots.js";

export const VIDEO_MODEL = "wan2.2-ti2v-5b";
export const DRAFT_VIDEO_MODEL = "wan2.1-t2v-1.3b";
export const VIDEO_MODELS = Object.freeze(["wan2.2-ti2v-5b", "wan2.1-t2v-1.3b", "wan2.2-t2v-a14b"]);
export const MAX_VIDEO_PROMPT_CHARS = 2000;

/**
 * `model: "chatrxl-uncensored"` is a two-step clip: a CPU worker draws the
 * first frame with ChatrXL (diffusion.txt2img), then Wan 2.2 TI2V 5B animates
 * it (video.img2vid, GPU). SFW only: adult jobs never take an image input
 * (the gateway and every worker refuse one), so an adult clip stays text to
 * video on Wan 2.2.
 */
export const KEYFRAME_VIDEO_MODELS = Object.freeze({
  "chatrxl-uncensored": { animate: "wan2.2-ti2v-5b", keyframe: { width: 1024, height: 576, steps: 8 } }
});
export const ALL_VIDEO_MODELS = Object.freeze([...VIDEO_MODELS, ...Object.keys(KEYFRAME_VIDEO_MODELS)]);

/**
 * $0.025 per clip. A CPU clip holds a whole 16-core worker for 20-30 minutes,
 * where an image ($0.002) holds it for ~2. Override with
 * INFERNET_VIDEO_PRICE_MICRO.
 */
export const DEFAULT_VIDEO_PRICE_MICRO = 25000;

export function videoPriceMicro(env = process.env) {
  const raw = Number(env?.INFERNET_VIDEO_PRICE_MICRO);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_VIDEO_PRICE_MICRO;
}

/**
 * Normalise a body to the gateway's /v1/videos spec (text to video only; the
 * gateway fills the model's own frame/size defaults), or explain why not.
 * Returns { ok: true, spec, long? } | { ok: false, error }.
 *
 * `long` is set for the shot models (Wan 2.2): { prompt, subject, model,
 * seconds, shots, vertical, seed?, negative_prompt? }, the request a long
 * clip runs from. `seconds` comes from the body, else the prompt ("a 30
 * second video"), else 30; 5 to 60.
 */
export function validateVideoRequest(body) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_VIDEO_PROMPT_CHARS) {
    return { ok: false, error: `Prompt must contain 1 to ${MAX_VIDEO_PROMPT_CHARS} characters` };
  }
  const model = body?.model ?? VIDEO_MODEL;
  if (!ALL_VIDEO_MODELS.includes(model)) return { ok: false, error: `Model must be one of: ${ALL_VIDEO_MODELS.join(", ")}` };
  if (body?.image !== undefined || body?.image_base64 !== undefined) {
    return { ok: false, error: "Image-to-video is not offered here; send a text prompt" };
  }
  const chain = KEYFRAME_VIDEO_MODELS[model];
  if (chain && body?.adult === true) {
    return {
      ok: false,
      error: `${model} video draws a first frame and animates it, and adult mode never takes an image input; in adult mode use the default video model`
    };
  }
  if (body?.seconds !== undefined && body?.seconds !== null && !Number.isFinite(Number(body.seconds))) {
    return { ok: false, error: "Seconds must be a number from 5 to 60" };
  }
  const spec = { model: chain ? chain.animate : model, prompt };
  const userNegative = typeof body?.negative_prompt === "string" && body.negative_prompt.trim() ? body.negative_prompt.trim().slice(0, MAX_VIDEO_PROMPT_CHARS) : "";
  if (userNegative) spec.negative_prompt = userNegative;
  if (body?.seed !== undefined && body?.seed !== null) {
    const seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      return { ok: false, error: "Seed must be an integer from 0 to 4294967295" };
    }
    spec.seed = seed;
  }
  if (chain) {
    const keyframe = { prompt, model, ...chain.keyframe };
    if (spec.seed !== undefined) keyframe.seed = spec.seed;
    return { ok: true, spec, keyframe };
  }
  if (SHOT_MODELS[model]) {
    const seconds = body?.seconds !== undefined && body?.seconds !== null ? clampSeconds(body.seconds) : secondsFromPrompt(prompt) ?? DEFAULT_CLIP_SECONDS;
    const long = { prompt, subject: subjectOf(prompt), model, seconds, shots: shotCount(seconds, model), vertical: body?.vertical === true };
    if (spec.seed !== undefined) long.seed = spec.seed;
    if (userNegative) long.negative_prompt = userNegative;
    return { ok: true, spec, long };
  }
  // A one-shot draft: the same fidelity rules (subjects restated, people ruled out for animals).
  const single = singleShotPrompts(prompt);
  spec.prompt = single.prompt;
  spec.negative_prompt = userNegative ? `${single.negative}, ${userNegative}`.slice(0, MAX_VIDEO_PROMPT_CHARS) : single.negative;
  return { ok: true, spec };
}

/**
 * Adult (18+) jobs: only from a trusted client (which verified the person's
 * 18+ attestation, e.g. c0mpute.com) and only on a paid balance, never the
 * free tier or an anonymous caller (admins are unmetered and count as paid). The c0mpute gateway and the worker still
 * apply the child-safety guard and refuse unless they opted in.
 * Returns null when allowed, else { status, error }.
 */
export function adultRefusal({ adult, trusted, billingMode }) {
  if (adult !== true) return null;
  if (!trusted) return { status: 403, error: "Adult mode is only available through a verified 18+ account (c0mpute.com)" };
  // An admin account is unmetered and counts as paid.
  if (billingMode !== "balance" && billingMode !== "admin") return { status: 402, error: "Adult mode needs a paid compute balance" };
  return null;
}

/** Statuses a gateway refusal keeps (policy 403/422, bad request 400). */
export function passthroughStatus(status) {
  return [400, 403, 422].includes(status) ? status : status === 503 ? 503 : 502;
}

/** `bytes=a-b` against a body of `size`: { start, end } or null (whole) or false (unsatisfiable). */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return false;
  let start;
  let end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return false;
  return { start, end };
}
