import "server-only";

import { streamChatCompletion, isNimConfigured } from "@infernetprotocol/nim-adapter";
import { MODEL_LYRICS_CHARS, clipText, durationFromBrief, MIN_MUSIC_SECONDS, MAX_MUSIC_SECONDS } from "./billing/music.js";

/**
 * Turn a free-form music brief into what ACE-Step 1.5 actually takes.
 *
 * ACE-Step reads a short style caption (256 tokens) and the lyrics as two
 * separate inputs, and sings only the lyrics it is given: a long brief that
 * says "rap verses, gang-vocal chorus, lyrics about rebellion" with no lyrics
 * comes out instrumental. So when the person gives no lyrics, a chat model
 * writes the caption, original lyrics with section tags and the length. When
 * no model is configured or it fails, the clipped brief is the caption and
 * the song is instrumental. Never throws.
 */

const WRITER_TIMEOUT_MS = 45_000;
const BRIEF_CHARS = 8_000;
const CAPTION_CHARS = 600;

export const MUSIC_WRITER_SYSTEM = [
  "You turn a music brief into input for the ACE-Step 1.5 song model.",
  "Reply with one JSON object and nothing else: {\"title\": string, \"caption\": string, \"lyrics\": string, \"duration\": number}.",
  "title: an original, catchy song title of 1 to 6 words that fits the brief (it goes on the cover art).",
  `caption: at most ${CAPTION_CHARS} characters of comma-separated style tags taken from the brief: genres, instruments, vocal type and delivery, mood, tempo in BPM, key. No sentences about structure, no lyrics.`,
  "lyrics: if the brief wants vocals, write ORIGINAL lyrics in English (or the language the brief asks for) that follow the structure the brief describes. Put each section on its own line in square brackets, e.g. [intro], [verse], [chorus], [bridge], [breakdown], [outro], with the sung or rapped lines under it. Make verses dense and rhythmic when it asks for rap, choruses short and repeatable. Fit the lyrics to the duration (about 2 to 3 lines per 10 seconds of vocals). If the brief wants an instrumental, use exactly \"[Instrumental]\".",
  `duration: the song length in seconds the brief asks for, from ${MIN_MUSIC_SECONDS} to ${MAX_MUSIC_SECONDS}; 60 if it does not say.`,
  "Never copy existing song lyrics; write new ones."
].join("\n");

/** Pull the JSON object out of a model reply, or null. */
export function parseWriterReply(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  const caption = typeof obj?.caption === "string" ? obj.caption.replace(/\s+/g, " ").trim() : "";
  const lyrics = typeof obj?.lyrics === "string" ? obj.lyrics.replace(/\r/g, "").trim() : "";
  const duration = Number(obj?.duration);
  if (caption.length < 8) return null;
  const title = typeof obj?.title === "string" ? obj.title.replace(/["\n\r]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return {
    title: title || null,
    caption: clipText(caption, CAPTION_CHARS),
    lyrics: clipText(lyrics, MODEL_LYRICS_CHARS),
    duration: Number.isFinite(duration) ? duration : null
  };
}

function clampDuration(n) {
  return Math.min(MAX_MUSIC_SECONDS, Math.max(MIN_MUSIC_SECONDS, Math.round(n)));
}

/**
 * { prompt, lyrics, duration, writer: "model" | "rules" | "none" } for a
 * validated request. `explicitDuration` is the caller's own number, if any.
 */
export async function writeMusicSpec(
  { prompt, lyrics, duration: explicitDuration },
  { stream = streamChatCompletion, configured = isNimConfigured() } = {}
) {
  const fromBrief = durationFromBrief(prompt);
  const pickDuration = (modelGuess) =>
    clampDuration(explicitDuration ?? fromBrief ?? modelGuess ?? 60);
  // The person wrote their own lyrics: use them as given.
  if (lyrics) return { prompt, lyrics, duration: pickDuration(null), writer: "none" };
  const rules = () => ({ prompt, lyrics: "", duration: pickDuration(null), writer: "rules" });
  if (!configured) return rules();
  try {
    let text = "";
    const signal = AbortSignal.timeout(WRITER_TIMEOUT_MS);
    for await (const ev of stream({
      messages: [
        { role: "system", content: MUSIC_WRITER_SYSTEM },
        { role: "user", content: `MUSIC BRIEF:\n${clipText(prompt, BRIEF_CHARS)}` }
      ],
      maxTokens: 1500,
      temperature: 0.8,
      signal
    })) {
      if (ev.type === "token") text += ev.data?.text ?? "";
      else if (ev.type === "done") text = ev.data?.text ?? text;
      else if (ev.type === "error") throw new Error(ev.data?.message ?? "writer failed");
    }
    const out = parseWriterReply(text);
    if (!out) return rules();
    const instrumental = !out.lyrics || /^\[instrumental\]$/i.test(out.lyrics);
    return {
      prompt: out.caption,
      lyrics: instrumental ? "" : out.lyrics,
      duration: pickDuration(out.duration),
      title: out.title,
      writer: "model"
    };
  } catch (e) {
    console.warn("[music-brief-writer]", e?.message ?? e);
    return rules();
  }
}
