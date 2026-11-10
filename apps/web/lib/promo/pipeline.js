// The promo pipeline, stage by stage, with every network call injected so it
// can be tested without a gateway:
//   brand -> script -> (frames -> motion) + voice + music -> render
// Frames, narration and the soundtrack run in parallel on c0mpute workers;
// motion (img2vid) starts per frame as frames land, when a video worker is
// online, and any scene without a clip gets Ken Burns camera moves instead.
//
// Every stage is idempotent and checkpointed on `job.checkpoint` (brand,
// script, each frame, clip and narration line, the soundtrack), with each
// artifact handed to `job.saveArtifact(name, bytes)` as it lands and
// `job.checkpointed()` called after: the registry keeps both in the media
// store. A job resumed after a restart (its files restored into job.dir)
// skips whatever its checkpoint already has.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PROMO_STAGES, PROMO_STYLES, DEFAULT_STYLE } from "./request.js";
import { musicCaption, scenePrompt, seedFor, writeStoryboard } from "./storyboard.js";
import { END_CARD_SECONDS, XFADE, buildTimeline, dimensions, wavSeconds } from "./assemble.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// When one promo finds no video worker, the others running or starting in the
// next half hour skip img2vid at once instead of each waiting out a probe:
// every one of them holds a promo slot while it waits.
const NO_VIDEO_MS = 30 * 60 * 1000;
let noVideoUntil = 0;
export function videoWorkersMissing(now = Date.now()) {
  return now < noVideoUntil;
}
export function markNoVideoWorker(now = Date.now()) {
  noVideoUntil = now + NO_VIDEO_MS;
}
export function resetVideoWorkerState() {
  noVideoUntil = 0;
}

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
  const ck = (job.checkpoint ??= {});
  ck.frames ??= {};
  ck.clips ??= {};
  ck.voice ??= {};
  const keep = async (name, bytes) => job.saveArtifact?.(name, bytes);
  const checkpoint = () => job.checkpointed?.();
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
  let brand;
  let logoPath = null;
  if (ck.brand) {
    brand = ck.brand.brand;
    logoPath = ck.brand.logo ? path.join(job.dir, ck.brand.logo) : null;
  } else {
    set("brand", "running", `reading ${request.url}`);
    const read = await deps.brand(request.url);
    logoPath = read.logo ? await deps.prepareLogo?.({ ...read.logo, dir: job.dir }) : null;
    if (logoPath) await keep(path.basename(logoPath), await readFile(logoPath));
    const { logo: _bytes, ...rest } = read;
    brand = rest;
    ck.brand = { brand, logo: logoPath ? path.basename(logoPath) : null };
    await checkpoint();
  }
  set("brand", "done", `${brand.name}${logoPath ? " · logo" : ""} · ${brand.colors.primary}`);
  publish({ brand: { name: brand.name, tagline: brand.tagline, host: brand.host, url: brand.url, colors: brand.colors, logo: Boolean(logoPath) } });

  // 2. Storyboard.
  if (!ck.script) {
    set("script", "running", "writing the storyboard");
    ck.script = await writeStoryboard({ brand, style, brief, vertical }, { stream: deps.stream, configured: deps.configured });
    await checkpoint();
  }
  const { storyboard, writer } = ck.script;
  const scenes = storyboard.scenes.map((s) => ({ ...s, frame: null, clip: null, voice: null, voiceSeconds: null }));
  // What a run before a restart already made.
  scenes.forEach((sc, i) => {
    if (ck.clips[i]) {
      sc.clip = path.join(job.dir, ck.clips[i].file);
      sc.clipSeconds = ck.clips[i].seconds;
    }
    if (ck.voice[i]) {
      sc.voice = path.join(job.dir, ck.voice[i].file);
      sc.voiceSeconds = ck.voice[i].seconds;
    }
  });
  const planned = scenes.reduce((a, s) => a + s.duration, 0);
  set("script", "done", `${scenes.length} scenes · ~${Math.round(planned)}s${writer === "rules" ? " (template)" : ""}`);
  const publicScenes = () => scenes.map((s) => ({ caption: s.caption, narration: s.narration, duration: s.duration, frame: Boolean(s.frame), clip: Boolean(s.clip) }));
  publish({ title: storyboard.title, tagline: storyboard.tagline || brand.tagline, mascot: storyboard.mascot, scenes: publicScenes() });

  const { W, H } = dimensions(vertical);
  const seed = seedFor(`${brand.host}|${style}`);
  // CPU workers draw ~350k pixels in about two minutes; ffmpeg upscales to 720p.
  const img = vertical ? { width: 448, height: 768 } : { width: 768, height: 448 };

  // 3a. Frames, then motion per frame.
  const videoCfg = deps.video ?? { enabled: false };
  let videoState = videoCfg.enabled ? ck.videoState ?? "unknown" : "off"; // unknown -> yes | no
  let videoProbe = null;
  const motionJobs = [];
  let framesDone = 0;
  let clipsDone = scenes.filter((sc) => sc.clip).length;
  set("frames", "running", `0/${scenes.length}`);
  set("motion", videoCfg.enabled ? "pending" : "skipped", videoCfg.enabled ? "waiting for frames" : "Ken Burns camera moves");

  async function animate(i) {
    if (videoState === "no" || videoState === "off") return;
    if (videoState === "unknown" && videoWorkersMissing()) {
      videoState = "no";
      ck.videoState = videoState;
      checkpoint();
      set("motion", "skipped", "no video worker free: Ken Burns camera moves");
      return;
    }
    if (videoState === "unknown") {
      // The first frame probes whether any video worker answers; the rest wait for it.
      if (!videoProbe) {
        set("motion", "running", `img2vid scene ${i + 1}`);
        videoProbe = tryClip(i, videoCfg.probeMs ?? videoCfg.budgetMs).then((ok) => {
          videoState = ok ? "yes" : "no";
          ck.videoState = videoState;
          checkpoint();
          if (!ok) {
            markNoVideoWorker();
            set("motion", "skipped", "no video worker free: Ken Burns camera moves");
          }
          return ok;
        });
        return videoProbe;
      }
      await videoProbe;
      if (videoState !== "yes") return;
    }
    return tryClip(i);
  }

  async function tryClip(i, waitMs = videoCfg.budgetMs ?? 20 * 60 * 1000) {
    const sc = scenes[i];
    if (sc.clip) return true;
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
      }, { maxWaitS: Math.max(1, Math.round(waitMs / 1000)) });
      if (!bytes || bytes.length < 1000) return false;
      const name = `clip-${i}.mp4`;
      const file = path.join(job.dir, name);
      await writeFile(file, bytes);
      sc.clip = file;
      sc.clipSeconds = (frames - 1) / fps;
      clipsDone++;
      await keep(name, bytes);
      ck.clips[i] = { file: name, seconds: sc.clipSeconds };
      checkpoint();
      set("motion", "running", `${clipsDone}/${scenes.length} scenes animated (img2vid)`);
      publish({ scenes: publicScenes() });
      return true;
    } catch (e) {
      console.warn(`[promo] img2vid scene ${i + 1}: ${e?.message ?? e}`);
      return false;
    }
  }

  // Two at a time: the network has few image workers, and a worker handed
  // several renders at once slows every one of them past its deadline.
  const framesTask = mapLimit(scenes, Number(process.env.PROMO_FRAME_CONCURRENCY) || 2, async (sc, i) => {
    if (ck.frames[i]) {
      const file = path.join(job.dir, ck.frames[i]);
      const png = await readFile(file).catch(() => null);
      if (png?.length > 8) {
        sc.frame = file;
        sc.frameBytes = png;
        framesDone++;
        set("frames", "running", `${framesDone}/${scenes.length}`);
        if (!sc.clip) motionJobs.push(animate(i));
        return true;
      }
      delete ck.frames[i];
    }
    const prompt = scenePrompt(storyboard, i, { style, colors: brand.colors, vertical });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // The request id lets a resumed job collect a frame the gateway
        // finished after this process died, instead of drawing it again.
        const png = await deps.gateway.image({ prompt, model: "z-image-turbo", ...img, steps: 8, seed }, { requestId: `${job.id}-frame-${i}-${attempt}`, resume: Boolean(job.resumed) && attempt === 1 });
        if (png?.length > 8) {
          const name = `frame-${i}.png`;
          const file = path.join(job.dir, name);
          await writeFile(file, png);
          sc.frame = file;
          sc.frameBytes = png;
          framesDone++;
          await keep(name, png);
          ck.frames[i] = name;
          checkpoint();
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
    if (ck.voiceDone) {
      const ok = scenes.filter((sc) => sc.voice).length;
      set("voice", ok ? "done" : "failed", ok ? `${ok}/${scenes.length} lines · ${voice}` : "no TTS worker answered; captions only");
      return;
    }
    set("voice", "running", "Kokoro narration");
    let ok = scenes.filter((sc) => sc.voice).length;
    await mapLimit(scenes, 3, async (sc, i) => {
      if (!sc.narration || sc.voice) return;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const wav = await deps.gateway.tts({ text: sc.narration, engine: "kokoro", voice, locale: "en-US", speed: 1.0 });
          const secs = wavSeconds(wav);
          if (secs) {
            const name = `voice-${i}.wav`;
            const file = path.join(job.dir, name);
            await writeFile(file, wav);
            sc.voice = file;
            sc.voiceSeconds = secs;
            ok++;
            await keep(name, wav);
            ck.voice[i] = { file: name, seconds: secs };
            checkpoint();
            set("voice", "running", `${ok}/${scenes.length} lines`);
            return;
          }
        } catch (e) {
          console.warn(`[promo] narration ${i + 1} attempt ${attempt}: ${e?.message ?? e}`);
        }
        await sleep(5000);
      }
    });
    ck.voiceDone = true;
    await checkpoint();
    set("voice", ok ? "done" : "failed", ok ? `${ok}/${scenes.length} lines · ${voice}` : "no TTS worker answered; captions only");
  })();

  // 3c. Soundtrack, sized to the planned cut (it loops if narration stretches it).
  const musicTask = (async () => {
    if (!wantMusic) {
      set("music", "skipped", "off");
      return null;
    }
    if (ck.music) {
      set("music", ck.music.file ? "done" : "failed", ck.music.file ? "instrumental" : "no music worker answered; narration only");
      return ck.music.file ? path.join(job.dir, ck.music.file) : null;
    }
    const estimate = buildTimeline(scenes.map((s) => ({ duration: s.duration, voiceSeconds: s.narration ? s.narration.split(/\s+/).length / 2.6 : 0 }))).total;
    const duration = Math.min(180, Math.max(10, Math.ceil(estimate + 3)));
    set("music", "running", `ACE-Step ${duration}s instrumental`);
    try {
      const out = await deps.gateway.music(
        { prompt: musicCaption(storyboard, style), lyrics: "", duration, model: "ace-step-1.5", seed },
        { requestId: job.id, resume: Boolean(job.resumed), onProgress: (line) => set("music", "running", line) }
      );
      if (!out?.bytes?.length) throw new Error("empty soundtrack");
      const name = `music.${out.type === "audio/flac" ? "flac" : out.type === "audio/wav" ? "wav" : "mp3"}`;
      const file = path.join(job.dir, name);
      await writeFile(file, out.bytes);
      await keep(name, out.bytes);
      ck.music = { file: name };
      await checkpoint();
      set("music", "done", `${duration}s instrumental`);
      return file;
    } catch (e) {
      console.warn(`[promo] music: ${e?.message ?? e}`);
      ck.music = { file: null };
      await checkpoint();
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
    if (videoState === "no" && stages.motion.state !== "skipped") set("motion", "skipped", "no video worker free: Ken Burns camera moves");
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
