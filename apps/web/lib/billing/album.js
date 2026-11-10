// Albums on c0mpute for /chat: `/album <prompt>` names a band, an album and
// 8-10 songs, then renders every track as its own ACE-Step 1.5 song job
// (see lib/chat/album-run.js). Pure helpers: command parsing, request
// validation, file names and the text files that go in the album zip.

import { MAX_MUSIC_PROMPT_CHARS, MAX_MUSIC_SECONDS, MIN_MUSIC_SECONDS, MUSIC_MODEL } from "./music.js";

export const MIN_ALBUM_TRACKS = 2;
export const MAX_ALBUM_TRACKS = 12;
export const DEFAULT_ALBUM_TRACKS = 8;
// Each track's length when the prompt does not say: long enough to be a
// song, short enough that a CPU worker renders it in ~10 minutes.
export const DEFAULT_TRACK_SECONDS = 120;

const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** "10 songs", "a nine-track album", "tracks: 6" in a prompt → that count, or null. */
export function trackCountFromPrompt(text) {
  const s = String(text ?? "").toLowerCase();
  let m = /\btracks?\s*[:=]\s*(\d{1,2})\b/.exec(s);
  if (!m) m = /\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]*(?:songs?|tracks?)\b/.exec(s);
  if (!m) return null;
  const n = NUMBER_WORDS[m[1]] ?? Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/** `/album dark synthwave about a dying city` → { prompt }, anything else → null. */
export function parseAlbumCommand(text) {
  const m = /^\/(?:album|lp)\s+([\s\S]+)$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const prompt = m[1].trim();
  return prompt ? { prompt } : null;
}

/**
 * { prompt, tracks?, duration? } → { ok: true, request } | { ok: false, error }.
 * `tracks` defaults to a count the prompt names, else 8; `duration` (seconds
 * per track) is left to the planner when not given.
 */
export function validateAlbumRequest(body) {
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_MUSIC_PROMPT_CHARS) {
    return { ok: false, error: `Prompt must contain 1 to ${MAX_MUSIC_PROMPT_CHARS} characters` };
  }
  const given = body?.tracks === undefined || body?.tracks === null ? null : Number(body.tracks);
  if (given !== null && (!Number.isInteger(given) || given < MIN_ALBUM_TRACKS || given > MAX_ALBUM_TRACKS)) {
    return { ok: false, error: `An album has ${MIN_ALBUM_TRACKS} to ${MAX_ALBUM_TRACKS} tracks` };
  }
  const fromPrompt = trackCountFromPrompt(prompt);
  const tracks = given ?? (fromPrompt ? Math.min(MAX_ALBUM_TRACKS, Math.max(MIN_ALBUM_TRACKS, fromPrompt)) : DEFAULT_ALBUM_TRACKS);
  const duration = body?.duration === undefined || body?.duration === null ? null : Number(body.duration);
  if (duration !== null && (!Number.isInteger(duration) || duration < MIN_MUSIC_SECONDS || duration > MAX_MUSIC_SECONDS)) {
    return { ok: false, error: `Duration must be a whole number of seconds from ${MIN_MUSIC_SECONDS} to ${MAX_MUSIC_SECONDS}` };
  }
  return { ok: true, request: { prompt, tracks, ...(duration ? { duration } : {}) } };
}

/** One status line for the chat from an album poll. */
export function describeAlbumStage(p) {
  const tracks = Array.isArray(p?.tracks) ? p.tracks : [];
  const total = tracks.length || p?.tracksWanted || 0;
  switch (p?.stage) {
    case "planning":
      return `Naming the band, the album and ${total || "its"} songs`;
    case "writing": {
      const written = tracks.filter((t) => t.lyrics).length;
      return `Writing lyrics · ${written}/${total} songs`;
    }
    case "recording": {
      const done = tracks.filter((t) => t.status === "done").length;
      const failed = tracks.filter((t) => t.status === "failed").length;
      const now = tracks.filter((t) => t.status === "pending" && t.node?.stage === "rendering").length;
      const queued = tracks.filter((t) => t.status === "pending" && t.node?.stage !== "rendering").length;
      return `Recording on c0mpute workers · ${done}/${total} done${now ? ` · ${now} rendering` : ""}${queued ? ` · ${queued} waiting for a worker` : ""}${failed ? ` · ${failed} failed` : ""}`;
    }
    case "cover":
      return "Songs done; finishing the cover";
    case "done":
      return "Album ready";
    default:
      return "Starting the album";
  }
}

/** A name safe as a file or folder on every OS (no path separators, no reserved chars). */
export function safeFileName(name, fallback = "untitled") {
  const s = String(name ?? "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- strip control characters
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80)
    .trim();
  return s || fallback;
}

/** "01 - Neon Rain" for track 1 of an album. */
export function trackFileBase(n, title) {
  return `${String(n).padStart(2, "0")} - ${safeFileName(title, `Track ${n}`)}`;
}

/** RFC 6266 Content-Disposition for a download: ASCII fallback plus the UTF-8 name. */
export function attachmentHeader(name) {
  const ascii = String(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** "Band - Album": the zip's name and its top folder. */
export function albumFolderName(plan) {
  return safeFileName(`${plan?.band ?? "Unknown Artist"} - ${plan?.album ?? "Untitled"}`, "album");
}

const isInstrumental = (lyrics) => !lyrics || /^\s*\[instrumental\]\s*$/i.test(lyrics);

/**
 * One song as an OpenSong 0.1 sheet: TITLE / STYLE / LYRICS label blocks
 * (the fields a song model takes), plus ARTIST, ALBUM, TRACK and MADE BY.
 */
export function trackLyricsText({ band, album, n, total, title, caption, lyrics }) {
  return [
    `TITLE: ${title}`,
    `ARTIST: ${band}`,
    `ALBUM: ${album}`,
    `TRACK: ${n}/${total}`,
    `STYLE: ${caption ?? ""}`,
    `MADE BY: ${MUSIC_MODEL} on c0mpute`,
    "",
    "LYRICS:",
    isInstrumental(lyrics) ? "[Instrumental]" : String(lyrics).trim(),
    ""
  ].join("\n");
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** album.txt: the band, the album, its concept and the track list. */
export function albumSheetText(plan, tracks = []) {
  const lines = [
    `ARTIST: ${plan.band}`,
    `ALBUM: ${plan.album}`,
    plan.genre ? `GENRE: ${plan.genre}` : null,
    plan.sound ? `SOUND: ${plan.sound}` : null,
    `MADE BY: ${MUSIC_MODEL} on c0mpute (songs), Z-Image-Turbo (cover)`,
    "",
    plan.concept ? `${plan.concept}\n` : null,
    "TRACKS:"
  ].filter((l) => l !== null);
  for (const t of tracks) {
    const len = Number.isFinite(t.duration) ? ` (${mmss(t.duration)})` : "";
    lines.push(`${String(t.n).padStart(2, "0")}. ${t.title}${len}${t.status === "failed" ? " [not rendered]" : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The cover art prompt for a whole album (Z-Image-Turbo, square): the album's
 * sound and concept as one image, with the band and album names as the only
 * lettering.
 */
export function albumCoverPrompt({ band, album, sound, concept }) {
  const clean = (s, n) => String(s ?? "").replace(/["\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  const style = clean(String(sound ?? "").replace(/\b\d+\s*bpm\b|\b[A-G](?:#|b)?\s*(?:major|minor)\b/gi, ""), 300).replace(/[\s,]+$/, "");
  return [
    "Square album cover artwork.",
    style ? `The music: ${style}.` : "",
    concept ? `The album is about: ${clean(concept, 300)}.` : "",
    "One bold, striking image that captures the album: a strong central subject, cinematic lighting, a rich color palette, a high-detail illustration or photo style that fits the genre.",
    `The only lettering is the band name "${clean(band, 50)}" and the album title "${clean(album, 60)}" in big, stylish, legible type that suits the genre.`,
    "Professional album art, centered composition, no frames, no borders, no watermark."
  ]
    .filter(Boolean)
    .join(" ");
}
