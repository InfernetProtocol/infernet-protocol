// The promo pipeline, stage by stage, with every network call injected so it
// can be tested without a gateway:
//   brand -> script -> (frames -> motion) + voice + music -> render
// Frames, narration and the soundtrack run in parallel on c0mpute workers;
// motion (img2vid) starts per frame as frames land, when a video worker is
// online, and any scene without a clip gets Ken Burns camera moves instead.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { PROMO_STAGES, PROMO_STYLES, DEFAULT_STYLE } from "./request.js";
import { musicCaption, scenePrompt, seedFor, writeStoryboard } from "./storyboard.js";
import { END_CARD_SECONDS, XFADE, buildTimeline, dimensions, wavSeconds } from "./assemble.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over items with at most `n` at once. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function stageBoard() {
  return Object.fromEntries(PROMO_STAGES.map((k) => [k, { state: "pending" }]));
}

/**
 * Run one promo. `job` is the registry entry (job.dir, job.meta);
 * `deps` = { brand(url), render(opts), gateway: { image, tts, music, video },
 *            stream, configured, video: { enabled, model, width, height } }.
 * Resolves to { video, srt, duration, bytes, frames, clips, music }.
 */
export async function runPromo(job, request, deps) {
  const { style = DEFAULT_STYLE, vertical = false, brief = "", voice = "af_bella", music: wantMusic = true } = request;
  const stages = stageBoard();
  const publish = (patch = {}) => {
    job.meta = { ...job.meta, ...patch, stages: { ...stages } };
  };
  const set = (k, state, detail) => {
    stages[k] = { state, ...(detail ? { detail: String(detail).slice(0, 160) } : {}) };
    publish({ stage: k });
  };
  publish({ style, styleLabel: PROMO_STYLES[style]?.label, vertical });

  // 1. Brand.
  set("brand", "running", `reading ${request.url}`);
  const brand = await deps.brand(request.url);
  const logoPath = brand.logo ? await deps.prepareLogo?.({ ...brand.logo, dir: job.dir }) : null;
  set("brand", "done", `${brand.name}${logoPath ? " · logo" : ""} · ${brand.colors.primary}`);
  publish({ brand: { name: brand.name, tagline: brand.tagline, host: brand.host, url: brand.url, colors: brand.colors, logo: Boolean(logoPath) } });

  // 2. Storyboard.
  set("script", "running", "writing the storyboard");
  const { storyboard, writer } = await writeStoryboard({ brand, style, brief, vertical }, { stream: deps.stream, configured: deps.configured });
  const scenes = storyboard.scenes.map((s) => ({ ...s, frame: null, clip: null, voice: null, voiceSeconds: null }));
  const planned = scenes.reduce((a, s) => a + s.duration, 0);
  set("script", "done", `${scenes.length} scenes · ~${Math.round(planned)}s${writer === "rules" ? " (template)" : ""}`);
  const publicScenes = () => scenes.map((s) => ({ caption: s.caption, narration: s.narration, duration: s.duration, frame: Boolean(s.frame), clip: Boolean(s.clip) }));
  publish({ title: storyboard.title, tagline: storyboard.tagline || brand.tagline, mascot: storyboard.mascot, scenes: publicScenes() });

  const { W, H } = dimensions(vertical);
  const seed = seedFor(`${brand.host}|${style}`);
  const img = vertical ? { width: 512, height: 896 } : { width: 896, height: 512 };

  // 3a. Frames, then motion per frame.
  const videoCfg = deps.video ?? { enabled: false };
  let videoState = videoCfg.enabled ? "unknown" : "off"; // unknown -> yes | no
  let videoProbe = null;
  const motionJobs = [];
  let framesDone = 0;
  let clipsDone = 0;
  set("frames", "running", `0/${scenes.length}`);
  set("motion", videoCfg.enabled ? "pending" : "skipped", videoCfg.enabled ? "waiting for frames" : "Ken Burns camera moves");

  async function animate(i) {
    if (videoState === "no" || videoState === "off") return;
    if (videoState === "unknown") {
      // The first frame probes whether any video worker answers; the rest wait for it.
      if (!videoProbe) {
        set("motion", "running", `img2vid scene ${i + 1}`);
        videoProbe = tryClip(i).then((ok) => {
          videoState = ok ? "yes" : "no";
          if (!ok) set("motion", "skipped", "no video worker free: Ken Burns camera moves");
          return ok;
        });
        return videoProbe;
      }
      await videoProbe;
      if (videoState !== "yes") return;
    }
    return tryClip(i);
  }

  async function tryClip(i) {
    const sc = scenes[i];
    const fps = 16;
    const frames = Math.min(81, Math.max(33, Math.round(sc.duration * fps / 4) * 4 + 1));
    try {
      const bytes = await deps.gateway.video({
        model: videoCfg.model,
        prompt: `${PROMO_STYLES[style]?.look ?? ""}. ${sc.visual}. Gentle natural motion, smooth camera move.`.slice(0, 1900),
        negative_prompt: "text, letters, watermark, logo, distorted face, extra limbs, flicker, blurry",
        frames,
        fps,
        steps: videoCfg.steps ?? 20,
        width: vertical ? videoCfg.height : videoCfg.width,
        height: vertical ? videoCfg.width : videoCfg.height,
        seed,
        image_format: "png",
        image_base64: sc.frameBytes.toString("base64")
      });
      if (!bytes || bytes.length < 1000) return false;
      const file = path.join(job.dir, `clip-${i}.mp4`);
      await writeFile(file, bytes);
      sc.clip = file;
      sc.clipSeconds = (frames - 1) / fps;
      clipsDone++;
      set("motion", "running", `${clipsDone}/${scenes.length} scenes animated (img2vid)`);
      publish({ scenes: publicScenes() });
      return true;
    } catch (e) {
      console.warn(`[promo] img2vid scene ${i + 1}: ${e?.message ?? e}`);
      return false;
    }
  }

  const framesTask = mapLimit(scenes, 4, async (sc, i) => {
    const prompt = scenePrompt(storyboard, i, { style, colors: brand.colors, vertical });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const png = await deps.gateway.image({ prompt, model: "z-image-turbo", ...img, steps: 8, seed });
        if (png?.length > 8) {
          const file = path.join(job.dir, `frame-${i}.png`);
          await writeFile(file, png);
          sc.frame = file;
          sc.frameBytes = png;
          framesDone++;
          set("frames", "running", `${framesDone}/${scenes.length}`);
          publish({ scenes: publicScenes() });
          motionJobs.push(animate(i));
          return true;
        }
      } catch (e) {
        console.warn(`[promo] frame ${i + 1} attempt ${attempt}: ${e?.message ?? e}`);
      }
      await sleep(attempt * 8000);
    }
    return false;
  });

  // 3b. Narration, one clip per scene so it lines up with its scene.
  const voiceTask = (async () => {
    set("voice", "running", "Kokoro narration");
    let ok = 0;
    await mapLimit(scenes, 3, async (sc, i) => {
      if (!sc.narration) return;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const wav = await deps.gateway.tts({ text: sc.narration, engine: "kokoro", voice, locale: "en-US", speed: 1.0 });
          const secs = wavSeconds(wav);
          if (secs) {
            const file = path.join(job.dir, `voice-${i}.wav`);
            await writeFile(file, wav);
            sc.voice = file;
            sc.voiceSeconds = secs;
            ok++;
            set("voice", "running", `${ok}/${scenes.length} lines`);
            return;
          }
        } catch (e) {
          console.warn(`[promo] narration ${i + 1} attempt ${attempt}: ${e?.message ?? e}`);
        }
        await sleep(5000);
      }
    });
    set("voice", ok ? "done" : "failed", ok ? `${ok}/${scenes.length} lines · ${voice}` : "no TTS worker answered; captions only");
  })();

  // 3c. Soundtrack, sized to the planned cut (it loops if narration stretches it).
  const musicTask = (async () => {
    if (!wantMusic) {
      set("music", "skipped", "off");
      return null;
    }
    const estimate = buildTimeline(scenes.map((s) => ({ duration: s.duration, voiceSeconds: s.narration ? s.narration.split(/\s+/).length / 2.6 : 0 }))).total;
    const duration = Math.min(180, Math.max(10, Math.ceil(estimate + 3)));
    set("music", "running", `ACE-Step ${duration}s instrumental`);
    try {
      const out = await deps.gateway.music(
        { prompt: musicCaption(storyboard, style), lyrics: "", duration, model: "ace-step-1.5", seed },
        { requestId: job.id, onProgress: (line) => set("music", "running", line) }
      );
      if (!out?.bytes?.length) throw new Error("empty soundtrack");
      const file = path.join(job.dir, `music.${out.type === "audio/flac" ? "flac" : out.type === "audio/wav" ? "wav" : "mp3"}`);
      await writeFile(file, out.bytes);
      set("music", "done", `${duration}s instrumental`);
      return file;
    } catch (e) {
      console.warn(`[promo] music: ${e?.message ?? e}`);
      set("music", "failed", "no music worker answered; narration only");
      return null;
    }
  })();

  const [framesOk] = await Promise.all([framesTask, voiceTask]);
  const got = framesOk.filter(Boolean).length;
  if (!got) throw Object.assign(new Error("No c0mpute image worker drew the storyboard; try again in a few minutes"), { status: 503 });
  // A scene whose frame failed borrows its neighbour's (a different camera move hides it).
  scenes.forEach((sc, i) => {
    if (sc.frame) return;
    const donor = scenes.slice(i).find((s) => s.frame) ?? [...scenes.slice(0, i)].reverse().find((s) => s.frame);
    sc.frame = donor.frame;
  });
  set("frames", "done", `${got}/${scenes.length} drawn`);

  // Motion gets a budget after the frames; whatever is not back by then is a still.
  if (videoCfg.enabled) {
    const budget = videoCfg.budgetMs ?? 20 * 60 * 1000;
    let timer;
    await Promise.race([Promise.allSettled(motionJobs), new Promise((r) => { timer = setTimeout(r, budget); })]);
    clearTimeout(timer);
    if (videoState === "yes") set("motion", "done", `${clipsDone}/${scenes.length} scenes img2vid${clipsDone < scenes.length ? ", the rest Ken Burns" : ""}`);
  }

  const musicFile = await musicTask;

  // 4. Render.
  set("render", "running", "ffmpeg");
  const rendered = await deps.render({
    dir: job.dir,
    scenes: scenes.map((s) => ({ frame: s.frame, clip: s.clip, clipSeconds: s.clipSeconds, duration: s.duration, caption: s.caption, narration: s.narration, voice: s.voice, voiceSeconds: s.voiceSeconds })),
    music: musicFile,
    logo: logoPath,
    brand: { name: brand.name, tagline: storyboard.tagline || brand.tagline, host: brand.host, url: brand.url, colors: brand.colors },
    vertical,
    onStep: (s) => set("render", "running", s)
  });
  set("render", "done", `${Math.round(rendered.duration)}s · ${W}x${H}`);
  const motion = clipsDone ? (clipsDone === scenes.length ? "img2vid" : "mixed") : "kenburns";
  publish({ motion, scenes: publicScenes(), endCard: END_CARD_SECONDS, xfade: XFADE });
  return { ...rendered, frames: got, clips: clipsDone, music: Boolean(musicFile), motion };
}
