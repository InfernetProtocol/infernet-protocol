// Music generation on c0mpute (music.txt2music, ACE-Step 1.5 on c0mpute
// workers) for /chat. Pure helpers: command parsing, request validation and
// the flat per-track price.

export const MUSIC_MODEL = "ace-step-1.5";
export const MAX_MUSIC_PROMPT_CHARS = 1000;
export const MAX_MUSIC_LYRICS_CHARS = 4000;
export const MIN_MUSIC_SECONDS = 10;
export const MAX_MUSIC_SECONDS = 120;
export const DEFAULT_MUSIC_SECONDS = 30;

/**
 * $0.005 per track. A 30 s song holds a whole worker for a few minutes on
 * CPU (less on a GPU), about twice an image. Override with
 * INFERNET_MUSIC_PRICE_MICRO.
 */
export const DEFAULT_MUSIC_PRICE_MICRO = 5000;

export function musicPriceMicro(env = process.env) {
  const raw = Number(env?.INFERNET_MUSIC_PRICE_MICRO);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_MUSIC_PRICE_MICRO;
}

/**
 * `/music lo-fi hip hop, rainy night` (also /song) → { prompt, lyrics }.
 * Lyrics follow a line that is exactly `lyrics:` (or a blank line after the
 * first line), so a whole song can be pasted:
 *
 *   /music upbeat synthpop, female vocals
 *   lyrics:
 *   [verse]
 *   neon on the water ...
 *
 * Anything else → null.
 */
export function parseMusicCommand(text) {
  const match = /^\/(?:music|song)\s+([\s\S]+)$/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const body = match[1].trim();
  const split = /\n\s*lyrics:\s*\n|\n\s*\n/i.exec(body);
  const prompt = (split ? body.slice(0, split.index) : body).trim();
  const lyrics = split ? body.slice(split.index + split[0].length).trim() : "";
  return prompt ? { prompt, lyrics } : null;
}

/**
 * Normalise a request body to the gateway's txt2music spec, or explain why not.
 *   { prompt, lyrics?, duration?, seed? } → { ok: true, spec } | { ok: false, error }
 * No lyrics means an instrumental track.
 */
export function validateMusicRequest(body) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_MUSIC_PROMPT_CHARS) {
    return { ok: false, error: `Prompt must contain 1 to ${MAX_MUSIC_PROMPT_CHARS} characters` };
  }
  const lyrics = typeof body?.lyrics === "string" ? body.lyrics.trim() : "";
  if (lyrics.length > MAX_MUSIC_LYRICS_CHARS) {
    return { ok: false, error: `Lyrics must be at most ${MAX_MUSIC_LYRICS_CHARS} characters` };
  }
  const duration = body?.duration === undefined || body?.duration === null ? DEFAULT_MUSIC_SECONDS : Number(body.duration);
  if (!Number.isInteger(duration) || duration < MIN_MUSIC_SECONDS || duration > MAX_MUSIC_SECONDS) {
    return { ok: false, error: `Duration must be a whole number of seconds from ${MIN_MUSIC_SECONDS} to ${MAX_MUSIC_SECONDS}` };
  }
  const spec = { prompt, lyrics, duration, model: MUSIC_MODEL };
  if (body?.seed !== undefined && body?.seed !== null) {
    const seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      return { ok: false, error: "Seed must be an integer from 0 to 4294967295" };
    }
    spec.seed = seed;
  }
  return { ok: true, spec };
}
