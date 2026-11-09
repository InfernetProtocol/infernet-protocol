// /promo in /chat: a 20-40 s cartoon promo video for a website, made on the
// c0mpute network (storyboard by a chat model, keyframes by Z-Image-Turbo,
// optional img2vid motion, Kokoro narration, an ACE-Step soundtrack) and cut
// together with ffmpeg on this server. Pure helpers, safe in the browser:
// command parsing, intent detection, request validation, styles and price.

export const PROMO_MODEL = "c0mpute-promo";

/**
 * Visual styles. `look` leads every keyframe prompt so the scenes share one
 * look; `music` is the default soundtrack caption for ACE-Step.
 */
export const PROMO_STYLES = Object.freeze({
  pixar: {
    label: "Pixar-style 3D cartoon",
    look: "Pixar-style 3D animated film still, soft global illumination, warm rim lighting, expressive rounded characters, subsurface scattering, shallow depth of field, rich saturated colors, cinematic composition",
    music: "uplifting orchestral pop, playful pizzicato strings, glockenspiel, warm brass, light percussion, bright and heartwarming, cinematic, 112 BPM"
  },
  anime: {
    label: "anime",
    look: "Japanese anime film still, cel-shaded, clean line art, vibrant sky gradients, dramatic lighting, Studio-quality background painting, expressive characters",
    music: "energetic J-pop instrumental, bright synths, driving drums, electric guitar, hopeful, 128 BPM"
  },
  claymation: {
    label: "claymation",
    look: "claymation stop-motion still, handmade plasticine characters and sets, visible fingerprints and texture, miniature diorama, soft studio lighting, charming and tactile",
    music: "quirky whimsical instrumental, ukulele, xylophone, hand claps, tuba, playful, 104 BPM"
  },
  flat: {
    label: "flat 2D motion graphics",
    look: "flat 2D vector illustration, clean geometric shapes, bold solid colors, minimal shading, modern explainer-video style, crisp edges",
    music: "modern corporate electronic pop, plucky synths, upbeat claps, positive and clean, 118 BPM"
  },
  watercolor: {
    label: "watercolor storybook",
    look: "watercolor storybook illustration, soft washes, paper texture, gentle hand-drawn ink lines, dreamy pastel light",
    music: "gentle acoustic instrumental, fingerpicked guitar, soft piano, warm strings, hopeful, 96 BPM"
  },
  comic: {
    label: "comic book",
    look: "bold comic book art, thick ink outlines, halftone shading, dynamic angles, punchy primary colors, action poses",
    music: "heroic upbeat rock instrumental, punchy drums, electric guitar riffs, brass hits, 130 BPM"
  },
  cinematic: {
    label: "cinematic live-action",
    look: "cinematic photorealistic film still, anamorphic lens, dramatic volumetric lighting, shallow depth of field, color graded, high detail",
    music: "epic cinematic trailer instrumental, pulsing synths, big drums, soaring strings, inspiring, 100 BPM"
  }
});

export const DEFAULT_STYLE = "pixar";

const STYLE_ALIASES = [
  [/\b(pixar|disney|dreamworks|3d cartoon|3-d cartoon|cgi cartoon)\b/i, "pixar"],
  [/\b(anime|manga|ghibli)\b/i, "anime"],
  [/\b(clay|claymation|stop[- ]?motion|plasticine|aardman)\b/i, "claymation"],
  [/\b(flat|2d|2-d|vector|motion graphics)\b/i, "flat"],
  [/\b(watercolou?r|storybook|painted)\b/i, "watercolor"],
  [/\b(comic|comic book|marvel|graphic novel)\b/i, "comic"],
  [/\b(cinematic|live[- ]action|photoreal(istic)?|realistic)\b/i, "cinematic"]
];

/** A style key from free text ("pixar style", "stop-motion"), or null. */
export function styleFromText(text) {
  const s = String(text ?? "");
  for (const [re, key] of STYLE_ALIASES) if (re.test(s)) return key;
  return null;
}

export function normalizeStyle(style) {
  const key = String(style ?? "").trim().toLowerCase();
  if (PROMO_STYLES[key]) return key;
  return styleFromText(key) ?? DEFAULT_STYLE;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/i;
const BARE_DOMAIN_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|dev|app|co|sh|xyz|world|gg|me|tv|so|tech|site|cloud|us|uk|de|fr|ca))(\/[^\s<>"'`)\]]*)?/i;
const VERTICAL_RE = /\b(vertical|portrait|9:16|9x16|shorts?|reels?|tiktok|stories)\b/i;

function firstUrl(text) {
  const m = URL_RE.exec(text);
  if (m) return m[0].replace(/[.,;:!?]+$/, "");
  const d = BARE_DOMAIN_RE.exec(text);
  return d ? `https://${d[0].replace(/[.,;:!?]+$/, "")}` : null;
}

function splitRequest(text) {
  const url = firstUrl(text);
  if (!url) return null;
  const style = styleFromText(text) ?? DEFAULT_STYLE;
  const vertical = VERTICAL_RE.test(text);
  const brief = text.replace(URL_RE, " ").replace(/\s+/g, " ").trim();
  return { url, style, vertical, brief };
}

/**
 * `/promo https://c0mpute.com pixar style vertical` (also /demo-video,
 * /promo-video) -> { url, style, vertical, brief }. Anything else -> null.
 */
export function parsePromoCommand(text) {
  const m = /^\/(?:promo|promo-video|demo-video|video-promo)\s+([\s\S]+)$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const req = splitRequest(m[1].trim());
  if (!req) return null;
  req.brief = req.brief.replace(/^\/\S+\s*/, "");
  return req;
}

/**
 * Plain-language asks for a promo or demo video of a URL route to /promo:
 * "make a pixar style promo video for https://c0mpute.com", "create a cartoon
 * demo video of example.com". Needs a link AND video words, so "summarize
 * https://..." or "/image a logo for x.com" never match.
 */
export function detectPromoRequest(text) {
  const s = String(text ?? "").trim();
  if (!s || s.startsWith("/")) return null;
  if (s.length > 2000) return null;
  const promoWord = /\b(promo|promotional|explainer|commercial|trailer|sizzle reel|advert|ad spot|demo video|launch video)\b/i.test(s);
  const videoWord = /\b(video|cartoon|animation|animated|clip|reel|short film)\b/i.test(s);
  const makeWord = /\b(make|create|generate|produce|build|render|do|want|need|give me|can you)\b/i.test(s);
  if (!(promoWord && (videoWord || makeWord)) && !(videoWord && makeWord && /\b(promo|demo|ad|cartoon|marketing|launch)\b/i.test(s))) {
    return null;
  }
  return splitRequest(s);
}

export const MAX_BRIEF_CHARS = 2000;
export const KOKORO_VOICES = ["af_bella", "af_sarah", "af_nicole", "am_michael", "am_onyx", "am_echo"];
export const DEFAULT_VOICE = "af_bella";

/**
 * Validate a POST body: { url, style?, vertical?, brief?, voice?, music? }.
 * -> { ok: true, request } | { ok: false, error }.
 */
export function validatePromoRequest(body) {
  const raw = typeof body?.url === "string" ? body.url.trim() : "";
  if (!raw || raw.length > 2048) return { ok: false, error: "url is required (a public http or https link)" };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "url is not a valid link" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "url must be http or https" };
  if (url.username || url.password) return { ok: false, error: "url must not contain credentials" };
  if (!url.hostname.includes(".") && !/^\[/.test(url.hostname)) return { ok: false, error: "url must name a public host" };
  const brief = typeof body?.brief === "string" ? body.brief.trim().slice(0, MAX_BRIEF_CHARS) : "";
  const voice = KOKORO_VOICES.includes(body?.voice) ? body.voice : DEFAULT_VOICE;
  if (body?.style !== undefined && body?.style !== null && typeof body.style !== "string") {
    return { ok: false, error: "style must be a string" };
  }
  return {
    ok: true,
    request: {
      url: url.href,
      style: normalizeStyle(body?.style ?? styleFromText(brief) ?? DEFAULT_STYLE),
      vertical: body?.vertical === true || body?.vertical === "true" || body?.aspect === "9:16",
      brief,
      voice,
      music: body?.music !== false
    }
  };
}

// ── price ────────────────────────────────────────────────────────────────────

/**
 * What one promo costs, from the work it took: each keyframe at the image
 * price, the soundtrack at the music price, narration and the storyboard at a
 * small flat amount, and each img2vid clip at the video price. Override the
 * parts with INFERNET_PROMO_*_MICRO.
 */
export const DEFAULT_PROMO_PRICES = Object.freeze({
  base: 3000, // storyboard + narration + the ffmpeg render here
  image: 2000,
  music: 5000,
  videoClip: 10000
});

export function promoPriceMicro({ frames = 0, music = false, clips = 0 } = {}, env = typeof process !== "undefined" ? process.env : {}) {
  const pick = (name, dflt) => {
    const v = Number(env?.[name]);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt;
  };
  const p = {
    base: pick("INFERNET_PROMO_BASE_MICRO", DEFAULT_PROMO_PRICES.base),
    image: pick("INFERNET_IMAGE_PRICE_MICRO", DEFAULT_PROMO_PRICES.image),
    music: pick("INFERNET_MUSIC_PRICE_MICRO", DEFAULT_PROMO_PRICES.music),
    videoClip: pick("INFERNET_PROMO_VIDEO_CLIP_MICRO", DEFAULT_PROMO_PRICES.videoClip)
  };
  return p.base + frames * p.image + (music ? p.music : 0) + clips * p.videoClip;
}

// ── progress ─────────────────────────────────────────────────────────────────

export const PROMO_STAGES = ["brand", "script", "frames", "motion", "voice", "music", "render"];
export const STAGE_LABELS = Object.freeze({
  brand: "Brand",
  script: "Script",
  frames: "Frames",
  motion: "Motion",
  voice: "Voice",
  music: "Music",
  render: "Render"
});

/** One status line per stage for the chat bubble. */
export function describePromoProgress(p) {
  const stages = p?.stages ?? {};
  const mark = (s) => (s === "done" ? "✓" : s === "running" ? "…" : s === "failed" ? "✗" : s === "skipped" ? "–" : "·");
  return PROMO_STAGES.map((k) => {
    const st = stages[k] ?? {};
    return `${mark(st.state)} ${STAGE_LABELS[k]}${st.detail ? `: ${st.detail}` : ""}`;
  }).join("\n");
}
