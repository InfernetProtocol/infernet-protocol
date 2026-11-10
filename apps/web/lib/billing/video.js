// Video generation on c0mpute (video.txt2vid; Wan 2.1 1.3B on CPU workers by
// default) for trusted clients such as c0mpute.com's /api/v1/videos. Pure
// helpers: request validation, the flat per-clip price and the adult rule.

export const VIDEO_MODEL = "wan2.1-t2v-1.3b";
export const VIDEO_MODELS = Object.freeze(["wan2.1-t2v-1.3b", "wan2.2-ti2v-5b"]);
export const MAX_VIDEO_PROMPT_CHARS = 2000;

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
 * Returns { ok: true, spec } | { ok: false, error }.
 */
export function validateVideoRequest(body) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_VIDEO_PROMPT_CHARS) {
    return { ok: false, error: `Prompt must contain 1 to ${MAX_VIDEO_PROMPT_CHARS} characters` };
  }
  const model = body?.model ?? VIDEO_MODEL;
  if (!VIDEO_MODELS.includes(model)) return { ok: false, error: `Model must be one of: ${VIDEO_MODELS.join(", ")}` };
  if (body?.image !== undefined || body?.image_base64 !== undefined) {
    return { ok: false, error: "Image-to-video is not offered here; send a text prompt" };
  }
  const spec = { model, prompt };
  if (typeof body?.negative_prompt === "string" && body.negative_prompt.trim()) {
    spec.negative_prompt = body.negative_prompt.trim().slice(0, MAX_VIDEO_PROMPT_CHARS);
  }
  if (body?.seed !== undefined && body?.seed !== null) {
    const seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      return { ok: false, error: "Seed must be an integer from 0 to 4294967295" };
    }
    spec.seed = seed;
  }
  return { ok: true, spec };
}

/**
 * Adult (18+) jobs: only from a trusted client (which verified the person's
 * 18+ attestation, e.g. c0mpute.com) and only on a paid balance, never the
 * free tier or an anonymous caller. The c0mpute gateway and the worker still
 * apply the child-safety guard and refuse unless they opted in.
 * Returns null when allowed, else { status, error }.
 */
export function adultRefusal({ adult, trusted, billingMode }) {
  if (adult !== true) return null;
  if (!trusted) return { status: 403, error: "Adult mode is only available through a verified 18+ account (c0mpute.com)" };
  if (billingMode !== "balance") return { status: 402, error: "Adult mode needs a paid compute balance" };
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
