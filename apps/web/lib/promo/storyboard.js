// The promo's storyboard: a chat model writes 5-8 scenes as JSON, this file
// validates and normalises it, and builds the style-locked keyframe prompt
// for each scene. Pure apart from the injected `stream` (the chat model).

import { PROMO_STYLES, DEFAULT_STYLE } from "./request.js";

export const MIN_SCENES = 5;
export const MAX_SCENES = 8;
export const MIN_SCENE_SECONDS = 3;
export const MAX_SCENE_SECONDS = 7;
export const MIN_TOTAL_SECONDS = 20;
export const MAX_TOTAL_SECONDS = 40;
export const MAX_NARRATION_CHARS = 180;
export const MAX_CAPTION_CHARS = 70;
export const MAX_VISUAL_CHARS = 450;
const MAX_IMAGE_PROMPT_CHARS = 1900; // the worker takes 2000

const oneLine = (v, max) =>
  String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[—–]/g, ", ")
    .trim()
    .slice(0, max)
    .trim();

/** Words a keyframe model should not try to draw. */
const noText = (s) => s.replace(/["“”]/g, "").replace(/\b(logo|wordmark|text that says|lettering|caption)\b/gi, "emblem");

function hexName(hex) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return null;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 510;
  if (max - min < 24) return l < 0.15 ? "near-black" : l > 0.85 ? "white" : "gray";
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  const names = [[15, "red"], [40, "orange"], [65, "yellow"], [160, "green"], [190, "teal"], [250, "blue"], [290, "purple"], [335, "pink"], [360, "red"]];
  const base = names.find(([deg]) => h < deg)?.[1] ?? "red";
  return `${l < 0.3 ? "deep " : l > 0.7 ? "light " : ""}${base}`;
}

/** "deep teal (#0f766e), orange (#f97316)" for the palette line of a prompt. */
export function paletteText(colors) {
  const list = [colors?.primary, colors?.secondary, colors?.accent].filter((c) => /^#[0-9a-f]{6}$/i.test(c ?? ""));
  return [...new Set(list)].map((c) => `${hexName(c)} (${c})`).join(", ");
}

export const STORYBOARD_SYSTEM = [
  "You are a creative director writing a short animated promo video for a website.",
  "Reply with ONE JSON object and nothing else, in this shape:",
  '{"title": string, "tagline": string, "mascot": string, "music": string, "scenes": [{"visual": string, "narration": string, "caption": string, "duration": number}]}',
  `scenes: ${MIN_SCENES} to ${MAX_SCENES} scenes, ${MIN_TOTAL_SECONDS} to ${MAX_TOTAL_SECONDS} seconds in total; each duration ${MIN_SCENE_SECONDS} to ${MAX_SCENE_SECONDS} seconds.`,
  "Story arc: a relatable problem, the product arriving as the hero, two or three concrete benefits taken from the site, and a confident final scene that invites the viewer to visit.",
  `mascot: one recurring character who appears in most scenes, described in one sentence with fixed, specific visual traits (species or type, colors, clothing, one signature prop) so every frame draws the same character.`,
  `visual: what the camera sees, at most ${MAX_VISUAL_CHARS} characters: setting, the mascot's action and expression, camera angle and lighting. Never ask for written words, letters, screens full of text or logos; show ideas visually.`,
  `narration: one or two short spoken sentences for a voice-over, at most ${MAX_NARRATION_CHARS} characters, about 2.5 words per second of the scene. Warm, punchy, specific to the product. Say the product name in the first and last scenes.`,
  `caption: an on-screen caption of at most ${MAX_CAPTION_CHARS} characters (a short version of the narration).`,
  "tagline: a short slogan for the end card (use the site's own tagline when it has one).",
  "music: comma-separated style tags for an instrumental background track that fits the mood (genres, instruments, tempo in BPM). No vocals.",
  "Use only facts the site gives; never invent prices, customers or numbers. Plain ASCII punctuation, no em dashes."
].join("\n");

/** The user message for the storyboard writer. */
export function storyboardPrompt({ brand, style, brief, vertical }) {
  const s = PROMO_STYLES[style] ?? PROMO_STYLES[DEFAULT_STYLE];
  const lines = [
    `WEBSITE: ${brand.url}`,
    `NAME: ${brand.name}`,
    brand.tagline ? `TAGLINE: ${brand.tagline}` : "",
    brand.description ? `DESCRIPTION: ${brand.description}` : "",
    brand.copy?.length ? `KEY COPY FROM THE PAGE:\n- ${brand.copy.slice(0, 12).join("\n- ")}` : "",
    brand.topics?.length ? `TOPICS: ${brand.topics.join(", ")}` : "",
    paletteText(brand.colors) ? `BRAND COLORS: ${paletteText(brand.colors)}` : "",
    `VISUAL STYLE: ${s.label}`,
    `FORMAT: ${vertical ? "vertical 9:16 for phones" : "widescreen 16:9"}`,
    brief ? `DIRECTION FROM THE CLIENT: ${brief}` : ""
  ];
  return lines.filter(Boolean).join("\n").slice(0, 8000);
}

function scaleDurations(scenes) {
  for (const sc of scenes) sc.duration = Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, sc.duration));
  const total = scenes.reduce((a, s) => a + s.duration, 0);
  const target = Math.min(MAX_TOTAL_SECONDS, Math.max(MIN_TOTAL_SECONDS, total));
  if (total !== target) {
    const k = target / total;
    for (const sc of scenes) sc.duration = Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, sc.duration * k));
  }
  for (const sc of scenes) sc.duration = Math.round(sc.duration * 10) / 10;
  return scenes;
}

/**
 * Validate a storyboard object (or a model reply containing one) and return
 * it normalised, or null when it is unusable: fewer than MIN_SCENES usable
 * scenes, no visuals, or not JSON. Extra scenes are dropped, text is clipped,
 * durations are clamped and scaled into 20-40 s.
 */
export function parseStoryboard(input, { brand = null } = {}) {
  let obj = input;
  if (typeof input === "string") {
    const s = input.replace(/```(?:json)?/gi, "");
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      obj = JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.scenes)) return null;
  const scenes = [];
  for (const raw of obj.scenes) {
    if (!raw || typeof raw !== "object") continue;
    const visual = oneLine(raw.visual ?? raw.prompt ?? raw.image, MAX_VISUAL_CHARS);
    const narration = oneLine(raw.narration ?? raw.voiceover ?? raw.vo, MAX_NARRATION_CHARS);
    const caption = oneLine(raw.caption ?? raw.text ?? narration, MAX_CAPTION_CHARS);
    const d = Number(raw.duration ?? raw.seconds);
    if (visual.length < 8) continue;
    scenes.push({ visual, narration, caption, duration: Number.isFinite(d) && d > 0 ? d : 4.5 });
    if (scenes.length >= MAX_SCENES) break;
  }
  if (scenes.length < MIN_SCENES) return null;
  scaleDurations(scenes);
  const name = brand?.name ?? "";
  return {
    title: oneLine(obj.title, 80) || (name ? `${name} promo` : "Promo"),
    tagline: oneLine(obj.tagline, 90) || oneLine(brand?.tagline, 90) || "",
    mascot: oneLine(obj.mascot ?? obj.character, 300),
    music: oneLine(obj.music, 300),
    scenes
  };
}

/** A storyboard without a model, from the brand alone, so a promo always gets made. */
export function fallbackStoryboard({ brand, style }) {
  const name = brand.name || brand.host || "this site";
  const pitch = oneLine(brand.tagline || brand.description || `the easiest way to get things done`, 120);
  const copy = (brand.copy ?? []).map((c) => oneLine(c, 120)).filter((c) => c.length > 12);
  const benefit = (i, dflt) => copy[i] ?? dflt;
  const mascot = style === "flat"
    ? "a friendly round robot with a glowing screen face, teal body and orange antenna"
    : "a cheerful small robot with big round eyes, a glossy teal body, an orange scarf and a tiny backpack";
  const scenes = [
    { visual: "the mascot at a cluttered desk late at night, surrounded by tangled cables and blinking warning lights, looking overwhelmed, moody blue lighting, wide shot", narration: `Ever feel like the tools you need are just out of reach?`, caption: "Sound familiar?", duration: 4.5 },
    { visual: `a bright doorway of warm light opens in the room and the mascot looks up in wonder, dust motes glowing, medium shot`, narration: `Meet ${name}.`, caption: `Meet ${name}`, duration: 4 },
    { visual: "the mascot happily gliding through a vibrant city of glowing interconnected buildings, dynamic tracking shot", narration: benefit(0, pitch), caption: oneLine(benefit(0, pitch), MAX_CAPTION_CHARS), duration: 5.5 },
    { visual: "the mascot high-fiving a crowd of diverse friendly characters around a giant glowing orb of energy, celebratory, low angle", narration: benefit(1, "Built for people and their AI agents alike."), caption: oneLine(benefit(1, "For people and agents"), MAX_CAPTION_CHARS), duration: 5.5 },
    { visual: "the mascot planting a small glowing seedling that grows into a huge tree of light connecting the whole world, sunrise, epic wide shot", narration: benefit(2, "Start small, grow without limits."), caption: oneLine(benefit(2, "Grow without limits"), MAX_CAPTION_CHARS), duration: 5.5 },
    { visual: "the mascot standing proudly on a hilltop at golden hour, waving at the camera, confetti in the air, hero shot", narration: `${name}. Try it today.`, caption: `Try ${name} today`, duration: 4.5 }
  ];
  return {
    title: `${name} promo`,
    tagline: oneLine(brand.tagline || brand.description, 90),
    mascot,
    music: "",
    scenes: scaleDurations(scenes.map((s) => ({ ...s, narration: oneLine(s.narration, MAX_NARRATION_CHARS), caption: oneLine(s.caption, MAX_CAPTION_CHARS) })))
  };
}

/**
 * The keyframe prompt for scene `i`: the style first (same words every
 * scene), then the scene, the recurring mascot and the brand palette, then
 * the no-lettering rule (the real logo is composited on the end card).
 */
export function scenePrompt(storyboard, i, { style = DEFAULT_STYLE, colors = null, vertical = false } = {}) {
  const s = PROMO_STYLES[style] ?? PROMO_STYLES[DEFAULT_STYLE];
  const scene = storyboard.scenes[i];
  const palette = paletteText(colors);
  return [
    `${s.look}.`,
    `Scene: ${noText(scene.visual)}.`,
    storyboard.mascot ? `Recurring character, identical in every scene: ${noText(storyboard.mascot)}.` : "",
    palette ? `Color palette accents: ${palette}.` : "",
    vertical ? "Vertical portrait composition, subject centered." : "Widescreen composition, subject slightly off center.",
    "No text, no letters, no words, no logos, no watermark, no signature."
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_IMAGE_PROMPT_CHARS);
}

/** The ACE-Step caption for the soundtrack: the writer's tags or the style's. */
export function musicCaption(storyboard, style) {
  const base = (PROMO_STYLES[style] ?? PROMO_STYLES[DEFAULT_STYLE]).music;
  const tags = oneLine(storyboard?.music, 300).replace(/\b(vocals?|singing|lyrics)\b/gi, "");
  return `${tags || base}, instrumental, no vocals, background music for a promo video`.slice(0, 600);
}

/** A stable 32-bit seed from a string, so one site keeps one look. */
export function seedFor(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 4294967295;
}

/**
 * Ask the chat model for a storyboard (one retry), falling back to the rule
 * storyboard. Never throws. -> { storyboard, writer: "model" | "rules" }.
 */
export async function writeStoryboard({ brand, style, brief, vertical }, { stream, configured = true, timeoutMs = 75_000 } = {}) {
  if (configured && stream) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        let text = "";
        const signal = AbortSignal.timeout(timeoutMs);
        for await (const ev of stream({
          messages: [
            { role: "system", content: STORYBOARD_SYSTEM },
            { role: "user", content: storyboardPrompt({ brand, style, brief, vertical }) }
          ],
          maxTokens: 2200,
          temperature: 0.8,
          signal
        })) {
          if (ev.type === "token") text += ev.data?.text ?? "";
          else if (ev.type === "done") text = ev.data?.text ?? text;
          else if (ev.type === "error") throw new Error(ev.data?.message ?? "storyboard writer failed");
        }
        const sb = parseStoryboard(text, { brand });
        if (sb) return { storyboard: sb, writer: "model" };
        console.warn(`[promo] storyboard attempt ${attempt}: unusable reply (${text.length} chars)`);
      } catch (e) {
        console.warn(`[promo] storyboard attempt ${attempt}:`, e?.message ?? e);
      }
    }
  }
  return { storyboard: fallbackStoryboard({ brand, style }), writer: "rules" };
}
