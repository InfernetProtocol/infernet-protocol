import "server-only";

import { streamChatCompletion, isNimConfigured } from "@infernetprotocol/nim-adapter";
import { clipText, durationFromBrief, MAX_MUSIC_SECONDS, MIN_MUSIC_SECONDS } from "./billing/music.js";
import { DEFAULT_TRACK_SECONDS } from "./billing/album.js";
import { writeMusicSpec } from "./music-brief-writer.js";
import { parseLooseJson } from "./loose-json.js";

/**
 * Plan an album from a free-form prompt: a band name, an album title, a
 * concept, the shared sound, and one entry per track (title, what it is
 * about, vocals or not, length). Then each track's caption and lyrics are
 * written by the /music brief writer from a brief that carries the album's
 * context, so the songs share a sound and a story. Never invents lyrics
 * from existing songs.
 */

const PLAN_TIMEOUT_MS = 60_000;
const PROMPT_CHARS = 6_000;
const PLAN_ATTEMPTS = 3;

export function albumPlannerSystem(count) {
  return [
    "You are an A&R person and songwriter planning an ORIGINAL album from a brief.",
    "Reply with one JSON object and nothing else:",
    '{"band": string, "album": string, "genre": string, "sound": string, "concept": string, "tracks": [{"title": string, "theme": string, "vocals": "yes" or "no", "duration": number}]}',
    "band: an original, memorable band or artist name (1 to 4 words) that fits the brief; use the name the brief gives if it gives one. Never a real, existing band.",
    "album: an original album title (1 to 6 words).",
    "genre: the main genre in a few words.",
    "sound: at most 400 characters of comma-separated style tags shared by every track: genres, instruments, vocal type and delivery, production, mood, tempo range.",
    "concept: one or two sentences on what the album is about.",
    `tracks: exactly ${count} entries in running order. title: an original song title of 1 to 6 words, all different. theme: one sentence on what that song is about and how it feels (vary tempo and mood across the album: an opener, a single, a slow one, a closer). vocals: "no" only for instrumental interludes or when the brief asks for instrumental music, else "yes". duration: seconds, ${MIN_MUSIC_SECONDS} to ${MAX_MUSIC_SECONDS}; ${DEFAULT_TRACK_SECONDS} unless the brief says otherwise.`
  ].join("\n");
}

const str = (v, max) => (typeof v === "string" ? v.replace(/[\r\n"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

const NO_VOCALS = /^(no|false|none|instrumental)$/i;

/** Parse and normalise the planner's reply to exactly `count` tracks, or null. */
export function parseAlbumPlan(text, count, { duration = null } = {}) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const obj = parseLooseJson(s.slice(start, end + 1));
  if (!obj) return null;
  const band = str(obj?.band, 60);
  const album = str(obj?.album, 80);
  const raw = Array.isArray(obj?.tracks) ? obj.tracks : [];
  if (!band || !album || raw.length < Math.min(2, count)) return null;
  const titles = new Set();
  const tracks = [];
  for (const t of raw) {
    if (tracks.length >= count) break;
    let title = str(t?.title, 60) || `Track ${tracks.length + 1}`;
    // Two songs with one title would collide in the zip.
    while (titles.has(title.toLowerCase())) title = `${title} (II)`;
    titles.add(title.toLowerCase());
    const d = Number(t?.duration);
    tracks.push({
      n: tracks.length + 1,
      title,
      theme: str(t?.theme, 400),
      vocals: !(t?.vocals === false || (typeof t?.vocals === "string" && NO_VOCALS.test(t.vocals.trim()))),
      duration: clampSeconds(duration ?? (Number.isFinite(d) ? d : DEFAULT_TRACK_SECONDS))
    });
  }
  return {
    band,
    album,
    genre: str(obj?.genre, 80),
    sound: str(obj?.sound, 600),
    concept: str(obj?.concept, 600),
    tracks
  };
}

function clampSeconds(n) {
  return Math.min(MAX_MUSIC_SECONDS, Math.max(MIN_MUSIC_SECONDS, Math.round(n)));
}

/**
 * { prompt, tracks, duration? } → the plan. Throws (status 503) when no
 * writer model is configured or it fails twice: an album needs names.
 */
export async function writeAlbumPlan({ prompt, tracks: count, duration = null }, { stream = streamChatCompletion, configured = isNimConfigured() } = {}) {
  if (!configured) throw Object.assign(new Error("Album writing is not configured (no writer model)"), { status: 503 });
  const perTrack = duration ?? durationFromBrief(prompt);
  for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
    try {
      let text = "";
      for await (const ev of stream({
        messages: [
          { role: "system", content: albumPlannerSystem(count) },
          { role: "user", content: `ALBUM BRIEF:\n${clipText(prompt, PROMPT_CHARS)}` }
        ],
        maxTokens: 2000,
        temperature: 0.9,
        signal: AbortSignal.timeout(PLAN_TIMEOUT_MS)
      })) {
        if (ev.type === "token") text += ev.data?.text ?? "";
        else if (ev.type === "done") text = ev.data?.text ?? text;
        else if (ev.type === "error") throw new Error(ev.data?.message ?? "planner failed");
      }
      const plan = parseAlbumPlan(text, count, { duration: perTrack && perTrack <= MAX_MUSIC_SECONDS ? perTrack : null });
      if (plan) return plan;
      console.warn(`[album-writer] attempt ${attempt}: unusable plan: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
    } catch (e) {
      console.warn(`[album-writer] attempt ${attempt}:`, e?.message ?? e);
    }
    if (attempt < PLAN_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000));
  }
  throw Object.assign(new Error("Could not write an album plan from that prompt — try again"), { status: 503 });
}

/** The brief the /music writer gets for one track: the album's context plus this song. */
export function trackBrief(plan, track, prompt) {
  return [
    `One song from the album "${plan.album}" by ${plan.band}.`,
    plan.genre ? `Genre: ${plan.genre}.` : "",
    plan.sound ? `Album sound (keep it): ${plan.sound}.` : "",
    plan.concept ? `Album concept: ${plan.concept}` : "",
    `This is track ${track.n} of ${plan.tracks.length}, titled "${track.title}": ${track.theme || "fits the album"}.`,
    track.vocals ? "It has vocals: write original lyrics for it." : "It is an instrumental: no vocals, no lyrics.",
    `Length: ${track.duration} seconds.`,
    `The person's original brief for the album: ${clipText(prompt, 1500)}`
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The ACE-Step input for one planned track: { caption, lyrics, duration }.
 * Lyrics are "[Instrumental]" for an instrumental (so the song job does not
 * write any) and when the writer could not produce any.
 */
export async function writeTrack(plan, track, prompt, deps) {
  if (!track.vocals) {
    return { caption: clipText(`${plan.sound}, instrumental`, 1000), lyrics: "[Instrumental]", duration: track.duration };
  }
  const written = await writeMusicSpec({ prompt: trackBrief(plan, track, prompt), lyrics: "", duration: track.duration }, deps);
  const ok = written.writer === "model";
  return {
    caption: ok ? written.prompt : clipText(plan.sound || plan.genre || prompt, 1000),
    lyrics: ok && written.lyrics ? written.lyrics : "[Instrumental]",
    duration: track.duration
  };
}
