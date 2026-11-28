// Long /video clips (the 30 s default) as a sequence of Wan shots.
//
// A Wan 2.2 5B render is about 5 s (121 frames at 24 fps); the model cannot
// draw 30 s in one pass and quality falls apart past ~10 s. So a clip is a
// short film: a chat model plans N shots of the SAME subjects, each shot is
// one render, and ffmpeg cuts them together.
//
// Prompt fidelity is the other half. A bare "a cat and a dog in heavy combat
// gear" on a small video model draws a soldier with a dog: the model's prior
// for "combat gear" is a person. Every shot prompt therefore restates the
// subjects literally ("a real domestic cat, an animal on four legs, wearing
// ..."), and when every subject is an animal the negative prompt rules out
// people. Pure: the chat model is injected (`stream`).

export const DEFAULT_CLIP_SECONDS = 30;
export const MIN_CLIP_SECONDS = 5;
export const MAX_CLIP_SECONDS = 60;
export const MAX_SHOTS = 12;
const MAX_PROMPT_CHARS = 1900; // the worker takes 2000

/** Models a long clip is cut from, with one shot's frames and rate. */
export const SHOT_MODELS = Object.freeze({
  "wan2.2-ti2v-5b": { frames: 121, fps: 24 },
  "wan2.2-t2v-a14b": { frames: 121, fps: 24 }
});

/** Wan's own recommended negative prompt (quality), in English. */
export const BASE_NEGATIVE =
  "blurry, low quality, low resolution, jpeg artifacts, distorted, deformed, disfigured, bad anatomy, extra limbs, extra legs, " +
  "fused limbs, mutated, malformed hands, bad hands, extra fingers, poorly drawn face, ugly, static, frozen frame, still image, " +
  "overexposed, oversaturated, flickering, watermark, text, subtitles, logo, signature, cartoon, 3d render, cgi, painting, illustration";
// The last few words keep a "realistic" clip photographic; dropped when the person asks for a drawn style.
const PHOTO_NEGATIVE = ", cartoon, 3d render, cgi, painting, illustration";
const DRAWN = /\b(cartoon|anime|animated|animation|pixar|claymation|clay|illustrat\w*|drawn|drawing|painting|painted|watercolor|sketch|comic|manga|3d render|cgi|low poly|pixel art|cel shaded)\b/i;

const ANIMALS = [
  "cat", "cats", "kitten", "kittens", "kitty", "dog", "dogs", "puppy", "puppies", "pup", "pups", "horse", "horses", "pony",
  "bear", "bears", "wolf", "wolves", "fox", "foxes", "lion", "lions", "tiger", "tigers", "monkey", "monkeys", "ape", "apes",
  "gorilla", "gorillas", "chimp", "chimpanzee", "raccoon", "raccoons", "rabbit", "rabbits", "bunny", "bunnies", "hamster",
  "hamsters", "mouse", "mice", "rat", "rats", "squirrel", "squirrels", "owl", "owls", "eagle", "eagles", "parrot", "parrots",
  "bird", "birds", "duck", "ducks", "goose", "geese", "chicken", "chickens", "penguin", "penguins", "frog", "frogs", "goat",
  "goats", "sheep", "cow", "cows", "pig", "pigs", "elephant", "elephants", "giraffe", "giraffes", "panda", "pandas", "otter",
  "otters", "koala", "koalas", "corgi", "corgis", "husky", "huskies", "labrador", "retriever", "shiba", "pug", "pugs",
  "dachshund", "poodle", "beagle", "bulldog", "shepherd", "tabby", "kangaroo", "deer", "moose", "badger", "hedgehog", "ferret",
  "llama", "llamas", "alpaca", "alpacas", "capybara", "capybaras", "lizard", "turtle", "turtles", "crocodile", "shark", "dolphin"
];
const ANIMAL_RE = new RegExp(`\\b(${ANIMALS.join("|")})\\b`, "i");
const HUMAN_RE =
  /\b(man|men|woman|women|person|people|human|humans|guy|girl|girls|boy|boys|lady|ladies|kid|kids|child|children|soldier|soldiers|marine|marines|warrior|knight|king|queen|player|chef|doctor|astronaut|pilot|cop|police|officer|crowd|family|couple|baby|teen|actor|actress|someone|anthropomorphic|humanoid|furry)\b/i;

/** Every subject named is an animal: no person anywhere in the prompt. */
export function animalsOnly(prompt) {
  const s = String(prompt ?? "");
  return ANIMAL_RE.test(s) && !HUMAN_RE.test(s);
}

const oneLine = (v, max) =>
  String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[—–]/g, ", ")
    .trim()
    .slice(0, max)
    .trim();

const UNIT = "(?:s|sec|secs|second|seconds|min|mins|minute|minutes)";
const LENGTH_RE = new RegExp(`\\b(\\d{1,3}(?:\\.\\d+)?)[\\s-]*(${UNIT})\\b(?:[\\s-]*long)?`, "i");

/**
 * The clip length a prompt asks for ("a 30 second video", "15s clip",
 * "1 minute"), clamped to MIN..MAX_CLIP_SECONDS, or null.
 */
export function secondsFromPrompt(prompt) {
  const m = LENGTH_RE.exec(String(prompt ?? ""));
  if (!m) return null;
  const n = Number(m[1]) * (/^m/i.test(m[2]) ? 60 : 1);
  if (!Number.isFinite(n) || n <= 0) return null;
  return clampSeconds(n);
}

export function clampSeconds(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_CLIP_SECONDS;
  return Math.max(MIN_CLIP_SECONDS, Math.min(MAX_CLIP_SECONDS, Math.round(v)));
}

/**
 * What the clip is of, without the request wrapper: "make a 30 second video
 * of a cat and a dog" -> "a cat and a dog". Falls back to the prompt.
 */
export function subjectOf(prompt) {
  const raw = oneLine(prompt, 2000);
  let s = raw
    .replace(/^(?:please\s+|pls\s+|can you\s+|could you\s+|i want\s+|i'd like\s+)*/i, "")
    .replace(/^(?:make|create|generate|render|produce|give me|show me|do|film|shoot)\s+(?:me\s+|us\s+)?/i, "");
  s = s.replace(LENGTH_RE, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:(?:an?|the|one)\s+)?(?:long\s+|short\s+|quick\s+|realistic\s+|cinematic\s+|hd\s+|4k\s+)*(?:video|clip|short|movie|film|animation|scene)s?\s+(?:of|showing|where|with|about|featuring|in which)\s+/i, "");
  s = s.replace(/^(?:video|clip|short|movie|film)\s*[:,-]\s*/i, "").trim();
  return s.length >= 3 ? s : raw;
}

/** Size of one shot: landscape 832x480, vertical 480x832 (multiples of 16). */
export function shotSize(vertical, env = process.env) {
  const num = (k, d) => {
    const v = Number(env?.[k]);
    return Number.isFinite(v) && v >= 256 && v % 16 === 0 ? v : d;
  };
  const long = num("CLIP_LONG_SIDE", 832);
  const short = num("CLIP_SHORT_SIDE", 480);
  return vertical ? { width: short, height: long } : { width: long, height: short };
}

export function shotSteps(env = process.env) {
  const v = Number(env?.CLIP_STEPS);
  return Number.isInteger(v) && v >= 8 && v <= 50 ? v : 25;
}

/** How many shots a clip of `seconds` is cut from on `model`. */
export function shotCount(seconds, model) {
  const m = SHOT_MODELS[model];
  if (!m) return 1;
  const per = (m.frames - 1) / m.fps; // 5 s
  return Math.max(1, Math.min(MAX_SHOTS, Math.round(clampSeconds(seconds) / per)));
}

// ── the shot plan (a chat model writes it, this validates it) ──────────────

export const PLAN_SYSTEM = [
  "You are a film director planning a short video for a text-to-video model (Wan 2.2).",
  "Reply with ONE JSON object and nothing else, in this shape:",
  '{"subjects": string, "setting": string, "style": string, "avoid": string, "shots": [string, ...]}',
  "subjects: who or what is on screen, written as a literal visual description the model cannot misread, reused word for word in every shot.",
  "  Keep exactly the subjects the person asked for, no more and no fewer. If they asked for animals, they are real animals (say the species, size, fur color, that it walks on four legs) wearing or doing what was asked, never people, soldiers or humanoids; e.g. a cat in combat gear is 'a real orange tabby house cat, a small four-legged animal, wearing a tiny tactical helmet and a fitted plate-carrier vest'.",
  "  Give each subject fixed traits (colors, clothing, props) so every shot draws the same characters.",
  "setting: the place, time of day and lighting, one sentence, the same across shots unless the story moves.",
  "style: the look, e.g. 'photorealistic live-action footage, shot on a cinema camera, shallow depth of field, natural motion' when they asked for realistic (that is the default); otherwise the style they asked for.",
  "avoid: comma-separated things the model is likely to draw by mistake for this prompt (e.g. 'human soldier, person, man, humanoid' for animals in gear). Short.",
  "shots: the requested number of shots, in order, each 5 seconds. Each shot is one sentence: the action, motion and camera move (wide establishing, tracking, close-up, slow motion, low angle...). Make it a little story with a beginning, middle and end; vary the camera; keep every shot on the subjects.",
  "Never ask for written words, captions or logos. Plain ASCII punctuation, no em dashes."
].join("\n");

export function planPrompt({ subject, shots, vertical }) {
  return [
    `REQUEST: ${subject}`,
    `SHOTS: ${shots}`,
    `FORMAT: ${vertical ? "vertical 9:16 for phones" : "widescreen 16:9"}`
  ].join("\n");
}

const CAMERA = [
  "wide establishing shot, the camera slowly pushes in",
  "medium tracking shot following them as they move",
  "low-angle shot, dramatic and powerful",
  "close-up on their faces and gear, shallow depth of field",
  "dynamic handheld shot in the middle of the action",
  "slow-motion shot of the key moment",
  "over-the-shoulder shot looking ahead with them",
  "aerial shot circling around them",
  "side profile tracking shot at their level",
  "final heroic wide shot as the camera pulls back"
];

/** The plan when no chat model answers: the subject, varied by camera. */
export function fallbackPlan({ subject, shots }) {
  const drawn = DRAWN.test(subject);
  return {
    subjects: animalsOnly(subject) ? `${subject} (real animals, not people)` : subject,
    setting: "",
    style: drawn ? "" : "photorealistic live-action footage, cinematic lighting, natural motion, highly detailed",
    avoid: "",
    shots: Array.from({ length: shots }, (_, i) => CAMERA[i % CAMERA.length])
  };
}

/** A plan object or a model reply containing one, normalised; null if unusable. */
export function parsePlan(input, { shots, subject }) {
  let obj = input;
  if (typeof input === "string") {
    const s = input.replace(/```(?:json)?/gi, "");
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try {
      obj = JSON.parse(s.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.shots)) return null;
  const list = obj.shots
    .map((x) => oneLine(typeof x === "string" ? x : x?.action ?? x?.visual ?? x?.prompt ?? "", 400))
    .filter((x) => x.length >= 8);
  const subjects = oneLine(obj.subjects, 600);
  if (list.length < Math.min(shots, 2) || subjects.length < 3) return null;
  while (list.length < shots) list.push(CAMERA[list.length % CAMERA.length]);
  return {
    subjects: animalsOnly(subject) && !/not (people|humans?)/i.test(subjects) ? `${subjects} (real animals, not people)` : subjects,
    setting: oneLine(obj.setting, 300),
    style: oneLine(obj.style, 250),
    avoid: oneLine(obj.avoid, 300),
    shots: list.slice(0, shots)
  };
}

/** Ask the chat model for a plan (two tries), else the camera-varied fallback. */
export async function writePlan({ subject, shots, vertical }, { stream = null, configured = true, timeoutMs = 60_000 } = {}) {
  if (configured && stream && shots > 1) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        let text = "";
        const signal = AbortSignal.timeout(timeoutMs);
        for await (const ev of stream({
          messages: [
            { role: "system", content: PLAN_SYSTEM },
            { role: "user", content: planPrompt({ subject, shots, vertical }) }
          ],
          maxTokens: 1600,
          temperature: 0.7,
          signal
        })) {
          if (ev.type === "token") text += ev.data?.text ?? "";
          else if (ev.type === "done") text = ev.data?.text ?? text;
          else if (ev.type === "error") throw new Error(ev.data?.message ?? "shot planner failed");
        }
        const plan = parsePlan(text, { shots, subject });
        if (plan) return { plan, writer: "model" };
        console.warn(`[clip] plan attempt ${attempt}: unusable reply (${text.length} chars)`);
      } catch (e) {
        console.warn(`[clip] plan attempt ${attempt}:`, e?.message ?? e);
      }
    }
  }
  return { plan: fallbackPlan({ subject, shots }), writer: "rules" };
}

/** The full prompt for shot `i`: subjects first (what the model weighs most), then action, setting, style. */
export function shotPrompt(plan, i, { subject = "" } = {}) {
  const parts = [plan.subjects, plan.shots[i], plan.setting, plan.style];
  // The person's own words ride along when the plan paraphrased them away.
  if (subject && !plan.subjects.toLowerCase().includes(subject.toLowerCase().slice(0, 40))) parts.push(`Scene: ${subject}`);
  return oneLine(parts.filter(Boolean).join(". ").replace(/\.\s*\./g, "."), MAX_PROMPT_CHARS);
}

/** Negative prompt: quality terms, the plan's likely mistakes, people when it is animals only, and the caller's own. */
export function shotNegative(plan, { subject = "", extra = "" } = {}) {
  const drawn = DRAWN.test(`${subject} ${plan.style}`);
  const parts = [drawn ? BASE_NEGATIVE.replace(PHOTO_NEGATIVE, "") : BASE_NEGATIVE];
  if (plan.avoid) parts.push(plan.avoid);
  if (animalsOnly(subject)) parts.push("human, person, people, man, woman, human soldier, humanoid, human face, human hands, anthropomorphic person");
  if (extra) parts.push(extra);
  return oneLine(parts.join(", "), MAX_PROMPT_CHARS);
}

/** The prompt a single (one-shot) clip renders: the same fidelity rules without a plan. */
export function singleShotPrompts(prompt) {
  const subject = subjectOf(prompt);
  const plan = fallbackPlan({ subject, shots: 1 });
  plan.shots = ["the camera moves smoothly with the action"];
  return { prompt: shotPrompt(plan, 0, { subject }), negative: shotNegative(plan, { subject }) };
}
