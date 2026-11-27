// Image generation on c0mpute (diffusion.txt2img on CPU workers) for /chat.
// Two models: Z-Image-Turbo (default) and ChatrXL Uncensored (SDXL/Pony,
// DMD2 8-step). Pure helpers: request validation and the flat per-image price.

export const IMAGE_MODEL = "z-image-turbo";
export const CHATRXL_MODEL = "chatrxl-uncensored";
export const IMAGE_MODELS = Object.freeze([IMAGE_MODEL, CHATRXL_MODEL]);
export const MAX_IMAGE_PROMPT_CHARS = 2000;

/** Sizes the chat offers. All multiples of 64, which the worker requires. */
export const IMAGE_SIZES = Object.freeze({
  landscape: { width: 768, height: 512 },
  square: { width: 640, height: 640 },
  portrait: { width: 512, height: 768 }
});

/**
 * ChatrXL is SDXL, trained near one megapixel: below ~0.5 MP it smears. These
 * stay inside the worker's 1024 px cap and a CPU job's time budget.
 */
export const CHATRXL_SIZES = Object.freeze({
  landscape: { width: 960, height: 640 },
  square: { width: 832, height: 832 },
  portrait: { width: 640, height: 960 }
});

/**
 * $0.002 per image. A CPU worker spends ~100 s of a whole 16-core box on one,
 * where a short chat answer bills ~5 micro-USD. Override with
 * INFERNET_IMAGE_PRICE_MICRO.
 */
export const DEFAULT_IMAGE_PRICE_MICRO = 2000;

export function imagePriceMicro(env = process.env) {
  const raw = Number(env?.INFERNET_IMAGE_PRICE_MICRO);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_IMAGE_PRICE_MICRO;
}

/** `/image a red bicycle` → "a red bicycle"; anything else → null. */
export function parseImageCommand(text) {
  const match = /^\/(?:image|img|draw)\s+([\s\S]+)$/i.exec(String(text ?? "").trim());
  return match ? match[1].trim() : null;
}

/**
 * Normalise a request body to the gateway's txt2img spec, or explain why not.
 * Returns { ok: true, spec } | { ok: false, error }.
 */
export function validateImageRequest(body) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    return { ok: false, error: `Prompt must contain 1 to ${MAX_IMAGE_PROMPT_CHARS} characters` };
  }
  const model = body?.model ?? IMAGE_MODEL;
  if (!IMAGE_MODELS.includes(model)) {
    return { ok: false, error: `Model must be one of: ${IMAGE_MODELS.join(", ")}` };
  }
  const sizeName = body?.size ?? "landscape";
  const size = (model === CHATRXL_MODEL ? CHATRXL_SIZES : IMAGE_SIZES)[sizeName];
  if (!size) {
    return { ok: false, error: `Size must be one of: ${Object.keys(IMAGE_SIZES).join(", ")}` };
  }
  const spec = { prompt, model, width: size.width, height: size.height, steps: 8 };
  if (body?.seed !== undefined && body?.seed !== null) {
    const seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      return { ok: false, error: "Seed must be an integer from 0 to 4294967295" };
    }
    spec.seed = seed;
  }
  return { ok: true, spec };
}
