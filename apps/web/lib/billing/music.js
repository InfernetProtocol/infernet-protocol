// Music generation on c0mpute (music.txt2music, ACE-Step 1.5 on c0mpute
// workers) for /chat. Pure helpers: command parsing, request validation and
// the flat per-track price.

export const MUSIC_MODEL = "ace-step-1.5";
// What a person may send: long style briefs and whole songs are fine.
export const MAX_MUSIC_PROMPT_CHARS = 100_000;
export const MAX_MUSIC_LYRICS_CHARS = 100_000;
// What reaches the worker. ACE-Step's tokenizer reads the first 256 tokens
// of the caption (~1000 chars) and 2048 of the lyrics, and the job spec rides
// in a gossiped offer capped at 64 KiB, so longer text is clipped here (at a
// word or line boundary) instead of being refused.
export const MODEL_PROMPT_CHARS = 1000;
export const MODEL_LYRICS_CHARS = 4000;

/** Clip to `max` characters, preferring to end at a line break or space. */
export function clipText(text, max) {
  const chars = Array.from(String(text ?? ""));
  if (chars.length <= max) return chars.join("");
  const head = chars.slice(0, max).join("");
  const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
  return (cut > head.length * 0.8 ? head.slice(0, cut) : head).trim();
}
export const MIN_MUSIC_SECONDS = 10;
// c0mpute gateway >= 0.2.84 takes up to 180 s.
export const MAX_MUSIC_SECONDS = 180;
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
  const explicit = body?.duration === undefined || body?.duration === null ? null : Number(body.duration);
  if (explicit !== null && (!Number.isInteger(explicit) || explicit < MIN_MUSIC_SECONDS || explicit > MAX_MUSIC_SECONDS)) {
    return { ok: false, error: `Duration must be a whole number of seconds from ${MIN_MUSIC_SECONDS} to ${MAX_MUSIC_SECONDS}` };
  }
  let seed;
  if (body?.seed !== undefined && body?.seed !== null) {
    seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      return { ok: false, error: "Seed must be an integer from 0 to 4294967295" };
    }
  }
  // `request` keeps the full text for the brief writer; `spec` is what the
  // gateway would get with no writing step (clipped, default length).
  const request = { prompt, lyrics, duration: explicit, ...(seed !== undefined ? { seed } : {}) };
  const spec = toGatewaySpec({ ...request, duration: explicit ?? DEFAULT_MUSIC_SECONDS });
  return { ok: true, request, spec };
}

/** The gateway's txt2music body: text clipped to what the model reads. */
export function toGatewaySpec({ prompt, lyrics, duration, seed }) {
  const spec = {
    prompt: clipText(prompt, MODEL_PROMPT_CHARS),
    lyrics: clipText(lyrics ?? "", MODEL_LYRICS_CHARS),
    duration: Math.min(MAX_MUSIC_SECONDS, Math.max(MIN_MUSIC_SECONDS, Math.round(duration ?? DEFAULT_MUSIC_SECONDS))),
    model: MUSIC_MODEL
  };
  if (seed !== undefined && seed !== null) spec.seed = seed;
  return spec;
}

/**
 * A song length the brief states, in seconds, or null: "150-second song",
 * "90 sec", "2-3 minutes" (the upper end), "2.5 min", "2:30".
 */
export function durationFromBrief(text) {
  const s = String(text ?? "").toLowerCase();
  let m = /\b(\d{1,2}):([0-5]\d)\b(?!\s*(?:am|pm))/.exec(s);
  if (m && /min|long|length|song|track/.test(s)) return Number(m[1]) * 60 + Number(m[2]);
  m = /\b(\d{2,3})\s*-?\s*(?:seconds?|secs?|s)\b/.exec(s);
  if (m) return Number(m[1]);
  m = /\b(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?)\s*-?\s*(?:minutes?|mins?)\b/.exec(s);
  if (m) return Math.round(Number(m[2]) * 60);
  m = /\b(\d+(?:\.\d+)?)\s*-?\s*(?:minutes?|mins?)\b/.exec(s);
  if (m) return Math.round(Number(m[1]) * 60);
  return null;
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * One line for the chat from the c0mpute gateway's live progress for a song
 * ({ stage, worker, eta_s, stage_elapsed_s, attempt, detail }).
 */
export function describeNodeProgress(p) {
  const node = typeof p?.worker === "string" ? `node …${p.worker.slice(-8)}` : "a node";
  const retry = (p?.attempt ?? 1) > 1 ? ` (attempt ${p.attempt})` : "";
  const inStage = Number.isFinite(p?.stage_elapsed_s) ? p.stage_elapsed_s : 0;
  switch (p?.stage) {
    case "starting":
    case "finding_worker":
      return `Finding a c0mpute music worker${retry}`;
    case "queued":
      return `Every music worker is busy; queued ${mmss(inStage)}`;
    case "rendering": {
      const left = Number.isFinite(p.eta_s) ? Math.max(0, p.eta_s - inStage) : null;
      const eta = left === null ? "" : left > 0 ? ` · ~${mmss(left)} left (node's estimate)` : " · past the node's estimate, still working";
      return `Rendering on ${node}${retry} · ${mmss(inStage)} in${eta}`;
    }
    case "fetching_result":
      return `Song finished on ${node}; fetching it`;
    case "retrying":
      return `${p.worker ? node : "The worker"} failed${p.detail ? ` (${p.detail})` : ""}; trying another worker`;
    case "done":
      return "Song ready";
    case "failed":
      return "Song failed";
    default:
      return "Composing on a c0mpute worker";
  }
}
