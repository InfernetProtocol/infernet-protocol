import "server-only";

import { streamChatCompletion, isNimConfigured } from "@infernetprotocol/nim-adapter";
import { clipText, durationFromBrief, durationRangeFromBrief, MAX_MUSIC_SECONDS, MIN_MUSIC_SECONDS } from "./billing/music.js";
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

/*
 * Distinct albums from one brief. 2026-11-15: three /album runs of the same
 * "celtic punk" prompt came back as one album three times (Raven's Requiem,
 * Ravenstone Rebellion, Ravenstone Rebels; two titled "Electric Highlands",
 * the same "Battle Cry" / "Victory or Death" track list, the same sound and a
 * near-identical cover). Each album now draws its own creative direction
 * (naming style, setting, era, lead voice, story angle, cover medium and
 * palette), is told what recent albums already used, and a plan too close to
 * one of them is written again.
 */
const DIRECTION = {
  naming: [
    "a place name (a real-sounding town, river, street or valley) used as the band name",
    "an invented single word that sounds good shouted",
    "\"The\" plus a plural noun that is NOT an animal or weapon",
    "a person's full name, as if a frontperson's project",
    "a two-word phrase built from an object and a color",
    "a phrase from a trade, workplace or piece of machinery",
    "an old-fashioned or archaic word nobody uses any more",
    "a number plus a noun",
    "a short slogan or command",
    "a word borrowed from another language that fits the genre's roots",
  ],
  setting: [
    "a harbor town in winter", "a mining valley", "a big city's night shift", "a border crossing", "a lighthouse on a small island",
    "a traveling fair", "a flooded farm", "a shipyard strike", "an all-night diner", "a mountain pass in a storm", "a factory closing day",
    "a wedding that goes wrong", "a long-haul truck route", "a city under curfew", "a fishing fleet lost at sea", "a ghost town revived",
  ],
  era: ["the 1840s", "the 1910s", "the 1950s", "the 1970s", "the 1990s", "the present day", "the near future", "a timeless myth"],
  voice: [
    "a female lead vocalist", "a male lead vocalist", "a male and female duet", "a gang-vocal choir with a gravelly lead",
    "a raspy alto lead", "a high tenor lead", "a spoken-word verse and sung chorus", "two trading lead singers",
  ],
  angle: [
    "told by one character from start to finish", "a love story", "a protest record", "a drinking record with a dark turn",
    "a family saga across three generations", "a revenge story", "a homecoming", "a road trip", "a heist", "a celebration of a lost friend",
    "an emigrant's letters home", "a comedy of misadventures",
  ],
  art: [
    "a linocut print", "a vintage screen-printed gig poster", "an oil painting", "a moody 35mm photograph", "a paper collage",
    "a watercolor illustration", "a woodcut engraving", "a risograph print", "a stained-glass design", "a comic-book panel",
    "a graffiti stencil", "a minimalist geometric design", "a pulp paperback cover", "a 3D-rendered diorama",
  ],
  palette: [
    "rust orange and navy", "emerald and gold", "black, white and one red accent", "teal and coral", "sepia and cream",
    "neon pink and electric blue", "forest green and bone white", "mustard yellow and purple", "slate grey and blood red",
    "sunset orange and deep violet",
  ],
};

const pick = (list, rand) => list[Math.floor(rand() * list.length) % list.length];

/** One album's creative direction (kept in the plan, so a resumed album keeps it). */
export function creativeDirection(rand = Math.random) {
  return Object.fromEntries(Object.entries(DIRECTION).map(([k, list]) => [k, pick(list, rand)]));
}

/** The planner's note on how this album must differ (and what it must not reuse). */
export function directionNote(direction, avoid = {}) {
  const lines = [
    "CREATIVE DIRECTION for THIS album (other albums are made from the same brief; this one must not sound or read like them):",
    `- band name style: ${direction.naming}`,
    `- setting: ${direction.setting}, ${direction.era}`,
    `- lead voice: ${direction.voice}`,
    `- story angle: ${direction.angle}`,
    "- song titles must be specific to this story; avoid stock titles like Battle Cry, Victory or Death, Rise Up, Rebel Heart.",
  ];
  const list = (label, xs, n) => (xs?.length ? `- do NOT reuse or resemble these ${label}: ${[...new Set(xs)].slice(0, n).join("; ")}` : "");
  lines.push(list("band names", avoid.bands, 60), list("album titles", avoid.albums, 60), list("song titles", avoid.songs, 120));
  return lines.filter(Boolean).join("\n");
}

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\b(the|of|and|a)\b/g, " ").replace(/\s+/g, " ").trim();
const stem = (w) => w.slice(0, 5);

/** Whether a plan's band or album title is too close to one already made. */
export function tooSimilar(plan, avoid = {}) {
  const near = (a, b) => {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const xs = new Set(x.split(" ").map(stem)), ys = y.split(" ").map(stem);
    return ys.some((w) => w.length >= 4 && xs.has(w)); // "Ravenstone Rebels" vs "Raven's Requiem": shared stem
  };
  return (avoid.bands ?? []).some((b) => near(plan.band, b)) || (avoid.albums ?? []).some((a) => norm(a) === norm(plan.album));
}

export function albumPlannerSystem(count, range = null) {
  return [
    "You are an A&R person and songwriter planning an ORIGINAL album from a brief.",
    "Reply with one JSON object and nothing else:",
    '{"band": string, "album": string, "genre": string, "sound": string, "concept": string, "tracks": [{"title": string, "theme": string, "vocals": "yes" or "no", "duration": number}]}',
    "band: an original, memorable band or artist name (1 to 4 words) that fits the brief; use the name the brief gives if it gives one. Never a real, existing band.",
    "album: an original album title (1 to 6 words).",
    "genre: the main genre in a few words.",
    "sound: at most 400 characters of comma-separated style tags shared by every track: genres, instruments, vocal type and delivery, production, mood, tempo range.",
    "concept: one or two sentences on what the album is about.",
    `tracks: exactly ${count} entries in running order. title: an original song title of 1 to 6 words, all different. theme: one sentence on what that song is about and how it feels (vary tempo and mood across the album: an opener, a single, a slow one, a closer). vocals: "no" only for instrumental interludes or when the brief asks for instrumental music, else "yes". duration: seconds, ${range
      ? `${range.min} to ${range.max} as the brief asks; spread the tracks across that range to suit each song (an interlude near the bottom, the epics near the top)`
      : `${MIN_MUSIC_SECONDS} to ${MAX_MUSIC_SECONDS}; ${DEFAULT_TRACK_SECONDS} unless the brief says otherwise`}.`
  ].join("\n");
}

const str = (v, max) => (typeof v === "string" ? v.replace(/[\r\n"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

const NO_VOCALS = /^(no|false|none|instrumental)$/i;

/** Parse and normalise the planner's reply to exactly `count` tracks, or null. */
export function parseAlbumPlan(text, count, { duration = null, range = null } = {}) {
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
      duration: clampSeconds(duration ?? (Number.isFinite(d) ? d : range ? Math.round((range.min + range.max) / 2) : DEFAULT_TRACK_SECONDS), range)
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

function clampSeconds(n, range = null) {
  const lo = range?.min ?? MIN_MUSIC_SECONDS;
  const hi = range?.max ?? MAX_MUSIC_SECONDS;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * { prompt, tracks, duration? } → the plan. Throws (status 503) when no
 * writer model is configured or it fails twice: an album needs names.
 */
export async function writeAlbumPlan({ prompt, tracks: count, duration = null }, { stream = streamChatCompletion, configured = isNimConfigured(), avoid = {}, rand = Math.random } = {}) {
  if (!configured) throw Object.assign(new Error("Album writing is not configured (no writer model)"), { status: 503 });
  // A range ("3 to 10 minutes") bounds each track; one length sets them all.
  const range = duration ? null : durationRangeFromBrief(prompt);
  const perTrack = duration ?? (range ? null : durationFromBrief(prompt));
  let lastSimilar = null;
  for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
    // A fresh direction each attempt, so a retry after a too-similar plan really differs.
    const direction = creativeDirection(rand);
    try {
      let text = "";
      for await (const ev of stream({
        messages: [
          { role: "system", content: albumPlannerSystem(count, range) },
          { role: "user", content: `ALBUM BRIEF:\n${clipText(prompt, PROMPT_CHARS)}\n\n${directionNote(direction, avoid)}` }
        ],
        maxTokens: 2000,
        temperature: 1.0,
        signal: AbortSignal.timeout(PLAN_TIMEOUT_MS)
      })) {
        if (ev.type === "token") text += ev.data?.text ?? "";
        else if (ev.type === "done") text = ev.data?.text ?? text;
        else if (ev.type === "error") throw new Error(ev.data?.message ?? "planner failed");
      }
      const plan = parseAlbumPlan(text, count, { duration: perTrack && perTrack <= MAX_MUSIC_SECONDS ? perTrack : null, range });
      if (plan && tooSimilar(plan, avoid) && attempt < PLAN_ATTEMPTS) {
        console.warn(`[album-writer] attempt ${attempt}: "${plan.band}" / "${plan.album}" is too close to an album already made; writing another`);
        lastSimilar = { ...plan, direction };
        continue;
      }
      if (plan) return { ...plan, direction };
      console.warn(`[album-writer] attempt ${attempt}: unusable plan: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
    } catch (e) {
      console.warn(`[album-writer] attempt ${attempt}:`, e?.message ?? e);
    }
    if (attempt < PLAN_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000));
  }
  if (lastSimilar) return lastSimilar;
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
