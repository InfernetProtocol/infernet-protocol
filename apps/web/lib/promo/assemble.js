// Final step of a promo: cut keyframes (or img2vid clips), narration and the
// soundtrack into one H.264 + AAC MP4 with burned-in captions, crossfades and
// a brand-colored end card with the real logo, plus an .srt. Runs ffmpeg on
// this server (the image ships it, see docker/Dockerfile).
//
// Argument builders are pure and tested with fixtures; `renderPromo` runs them.

import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile, stat } from "node:fs/promises";
import path from "node:path";

export const FPS = 30;
export const XFADE = 0.5; // seconds of crossfade between segments
export const END_CARD_SECONDS = 4;
const VOICE_LEAD = 0.3; // narration starts this long into a scene
const VOICE_TAIL = 0.6; // and leaves this much room before the next one
const TRANSITIONS = ["fade", "smoothleft", "circleopen", "slideup", "dissolve", "smoothright", "radial"];

export function dimensions(vertical) {
  return vertical ? { W: 720, H: 1280 } : { W: 1280, H: 720 };
}

// ── small pure helpers ───────────────────────────────────────────────────────

/** Seconds of audio in a PCM WAV buffer, or null. */
export function wavSeconds(buf) {
  if (!buf || buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") return null;
  let off = 12;
  let byteRate = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("latin1", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(off + 16);
    if (id === "data") {
      if (!byteRate) return null;
      // Streamed WAVs leave the size at 0 or 0xffffffff: use what is there.
      if (size === 0 || size === 0xffffffff || off + 8 + size > buf.length) size = buf.length - off - 8;
      return size / byteRate;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Word-wrap to lines of at most `width` characters (max `lines` lines). */
export function wrapText(text, width = 38, lines = 2) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= width) cur += " " + w;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = `${kept[lines - 1].replace(/[.,;:!?]*$/, "")}...`;
    return kept.join("\n");
  }
  return out.join("\n");
}

const srtTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

/** SubRip text from [{ start, end, text }]. */
export function toSrt(cues) {
  return cues
    .filter((c) => c.text && c.end > c.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${wrapText(c.text, 42, 3)}\n`)
    .join("\n");
}

/**
 * Where each segment sits. Scenes are stretched to fit their narration;
 * segment k starts at offset_k = sum(previous durations) - k * XFADE.
 * -> { segments: [{ start, duration }], total, offsets }
 */
export function buildTimeline(scenes, { endCard = END_CARD_SECONDS, xfade = XFADE } = {}) {
  const durations = scenes.map((s) => {
    const need = s.voiceSeconds ? s.voiceSeconds + VOICE_LEAD + VOICE_TAIL + xfade : 0;
    return Math.round(Math.max(s.duration ?? 4, need, 2) * 100) / 100;
  });
  if (endCard > 0) durations.push(endCard);
  const segments = [];
  const offsets = [];
  let t = 0;
  durations.forEach((d, k) => {
    const start = k === 0 ? 0 : t - xfade;
    if (k > 0) offsets.push(Math.round(start * 1000) / 1000);
    segments.push({ start: Math.round(start * 1000) / 1000, duration: d });
    t = start + d;
  });
  return { segments, offsets, total: Math.round(t * 1000) / 1000 };
}

/** Escape a value for an ffmpeg filter option ('...' quoting). */
const fq = (s) => {
  const v = String(s);
  // Paths are ours (job dir, font); refuse anything that would need escaping.
  if (/['\\:;,[\]]/.test(v)) throw new Error(`unsafe path for an ffmpeg filter: ${v}`);
  return `'${v}'`;
};
const ffColor = (hex, alpha) => `0x${String(hex).replace("#", "")}${alpha !== undefined ? `@${alpha}` : ""}`;

/** The ffmpeg drawtext filter for a caption kept in a text file. */
export function captionFilter({ textFile, font, W, H, color = "#14b8a6" }) {
  const size = Math.round(Math.min(W, H) * 0.052);
  return [
    `drawtext=fontfile=${fq(font)}`,
    `textfile=${fq(textFile)}`,
    `fontsize=${size}`,
    `fontcolor=white`,
    `line_spacing=${Math.round(size * 0.25)}`,
    `borderw=2`,
    `bordercolor=black@0.6`,
    `box=1`,
    `boxcolor=${ffColor(color, 0.72)}`,
    `boxborderw=${Math.round(size * 0.45)}`,
    `x=(w-text_w)/2`,
    `y=h-text_h-${Math.round(H * 0.09)}`
  ].join(":");
}

/** Ken Burns motion for one still: zoom in/out or pan, varied by `variant`. */
export function kenBurnsFilter({ W, H, frames, variant = 0 }) {
  const N = Math.max(1, frames - 1);
  const moves = [
    { z: `1+0.12*on/${N}`, x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" },
    { z: `1.13-0.12*on/${N}`, x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" },
    { z: "1.12", x: `(iw-iw/zoom)*on/${N}`, y: "ih/2-(ih/zoom/2)" },
    { z: "1.12", x: `(iw-iw/zoom)*(1-on/${N})`, y: "ih/2-(ih/zoom/2)" },
    { z: `1.04+0.08*on/${N}`, x: "iw/2-(iw/zoom/2)", y: `(ih-ih/zoom)*(1-on/${N})` }
  ];
  const m = moves[((variant % moves.length) + moves.length) % moves.length];
  // Upscale first: zoompan rounds to whole pixels, which shakes at 1x.
  return [
    `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase`,
    `crop=${W * 2}:${H * 2}`,
    `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=${W}x${H}:fps=${FPS}`,
    "setsar=1"
  ].join(",");
}

const X264 = (threads) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", String(threads)];

/** ffmpeg args: one scene from a still, with motion and its caption. */
export function stillSceneArgs({ frame, out, duration, W, H, variant, captionFile, font, color, threads = 4 }) {
  const frames = Math.max(2, Math.round(duration * FPS));
  const vf = [kenBurnsFilter({ W, H, frames, variant })];
  if (captionFile && font) vf.push(captionFilter({ textFile: captionFile, font, W, H, color }));
  vf.push("format=yuv420p");
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", frame, "-vf", vf.join(","), "-frames:v", String(frames), "-r", String(FPS), ...X264(threads), "-an", out];
}

/** ffmpeg args: one scene from an img2vid clip, fitted to the scene length. */
export function clipSceneArgs({ clip, clipSeconds, out, duration, W, H, captionFile, font, color, threads = 4 }) {
  const slow = clipSeconds && clipSeconds < duration ? Math.min(duration / clipSeconds, 1.6) : 1;
  const vf = [
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
    `setpts=${slow.toFixed(3)}*(PTS-STARTPTS)`,
    `fps=${FPS}`,
    `tpad=stop_mode=clone:stop_duration=${Math.ceil(duration)}`,
    `trim=duration=${duration}`,
    "setpts=PTS-STARTPTS",
    "setsar=1"
  ];
  if (captionFile && font) vf.push(captionFilter({ textFile: captionFile, font, W, H, color }));
  vf.push("format=yuv420p");
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", clip, "-vf", vf.join(","), "-t", String(duration), "-r", String(FPS), ...X264(threads), "-an", out];
}

/**
 * ffmpeg args: the end card. The last keyframe blurred under a brand-colored
 * wash (or a flat brand color), the real logo on top, then name, tagline and
 * URL. Text comes from files so nothing needs escaping.
 */
export function endCardArgs({ out, W, H, duration = END_CARD_SECONDS, background, primary, text = "#ffffff", backdrop = null, logo = null, nameFile, taglineFile, urlFile, font, threads = 4 }) {
  const inputs = [];
  let bg;
  if (backdrop) {
    inputs.push("-loop", "1", "-t", String(duration), "-i", backdrop);
    bg = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,drawbox=x=0:y=0:w=iw:h=ih:color=${ffColor(background, 0.78)}:t=fill,setsar=1[bg]`;
  } else {
    inputs.push("-f", "lavfi", "-t", String(duration), "-i", `color=c=${ffColor(background)}:s=${W}x${H}:r=${FPS}`);
    bg = "[0:v]setsar=1[bg]";
  }
  const parts = [bg];
  let last = "bg";
  const minSide = Math.min(W, H);
  const logoH = Math.round(minSide * 0.3);
  const textTop = logo ? Math.round(H * 0.5 - minSide * 0.02) : Math.round(H * 0.36);
  if (logo) {
    inputs.push("-loop", "1", "-t", String(duration), "-i", logo);
    parts.push(`[1:v]scale=-2:${logoH},format=rgba[logo]`);
    parts.push(`[${last}][logo]overlay=x=(W-w)/2:y=${Math.round(H * 0.5 - minSide * 0.08 - logoH)}[withlogo]`);
    last = "withlogo";
  }
  const nameSize = Math.round(minSide * 0.1);
  const tagSize = Math.round(minSide * 0.045);
  const urlSize = Math.round(minSide * 0.042);
  const draw = (file, size, color, y) =>
    `drawtext=fontfile=${fq(font)}:textfile=${fq(file)}:fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}:line_spacing=${Math.round(size * 0.2)}`;
  const texts = [draw(nameFile, nameSize, ffColor(text), textTop)];
  if (taglineFile) texts.push(draw(taglineFile, tagSize, ffColor(text, 0.88), textTop + Math.round(nameSize * 1.35)));
  if (urlFile) {
    const urlY = textTop + Math.round(nameSize * 1.35) + (taglineFile ? Math.round(tagSize * 3.2) : 0);
    texts.push(
      `drawbox=x=(iw-${Math.round(W * 0.56)})/2:y=${urlY - Math.round(urlSize * 0.55)}:w=${Math.round(W * 0.56)}:h=${Math.round(urlSize * 2.1)}:color=${ffColor(primary, 0.9)}:t=fill`,
      draw(urlFile, urlSize, "white", urlY)
    );
  }
  parts.push(`[${last}]${texts.join(",")},fade=t=in:st=0:d=0.4,format=yuv420p[v]`);
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", "[v]", "-frames:v", String(Math.round(duration * FPS)), "-r", String(FPS), ...X264(threads), "-an", out
  ];
}

/**
 * ffmpeg args: crossfade the segments, lay narration at each scene's start,
 * duck the music under it, normalise to about -14 LUFS, encode the MP4.
 */
export function finalArgs({ segments, timeline, voices = [], music = null, out, threads = 4 }) {
  const inputs = [];
  segments.forEach((seg) => inputs.push("-i", seg));
  const parts = [];
  // Video: a chain of xfades.
  let v = "0:v";
  timeline.offsets.forEach((offset, i) => {
    const k = i + 1;
    const isEnd = k === segments.length - 1;
    const transition = isEnd ? "fade" : TRANSITIONS[i % TRANSITIONS.length];
    const outLabel = `x${k}`;
    parts.push(`[${v}][${k}:v]xfade=transition=${transition}:duration=${XFADE}:offset=${offset}[${outLabel}]`);
    v = outLabel;
  });
  parts.push(`[${v}]format=yuv420p[vout]`);

  // Audio.
  const total = timeline.total;
  let idx = segments.length;
  const voiceLabels = [];
  voices.forEach((vo) => {
    if (!vo?.file) return;
    inputs.push("-i", vo.file);
    const ms = Math.max(0, Math.round((vo.start + VOICE_LEAD) * 1000));
    parts.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[vo${idx}]`);
    voiceLabels.push(`[vo${idx}]`);
    idx++;
  });
  let musicLabel = null;
  if (music) {
    inputs.push("-stream_loop", "-1", "-i", music);
    const fadeOut = Math.max(0, total - 2.5).toFixed(2);
    parts.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOut}:d=2.5,volume=0.55[mus]`);
    musicLabel = "[mus]";
    idx++;
  }
  let mix;
  if (voiceLabels.length) {
    parts.push(`${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:normalize=0:duration=longest,apad=whole_dur=${total},atrim=0:${total},volume=1.6[voice]`);
    if (musicLabel) {
      parts.push("[voice]asplit=2[vmain][vkey]");
      parts.push(`${musicLabel}[vkey]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450:makeup=1[ducked]`);
      parts.push("[vmain][ducked]amix=inputs=2:normalize=0:duration=first[mix]");
    } else {
      parts.push("[voice]anull[mix]");
    }
    mix = "[mix]";
  } else if (musicLabel) {
    mix = musicLabel;
  } else {
    inputs.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=48000:cl=stereo");
    mix = `[${idx}:a]`;
    idx++;
  }
  parts.push(`${mix}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high", "-pix_fmt", "yuv420p", "-threads", String(threads),
    "-r", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-t", String(total),
    "-movflags", "+faststart",
    out
  ];
}

// ── running ffmpeg ───────────────────────────────────────────────────────────

const FONT_CANDIDATES = [
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf", // alpine font-dejavu
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", // debian/ubuntu
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/liberation/LiberationSans-Bold.ttf"
];

/** A bold sans font file for captions, or null. PROMO_FONT overrides. */
export function findFont(env = process.env) {
  if (env.PROMO_FONT && existsSync(env.PROMO_FONT)) return env.PROMO_FONT;
  for (const f of FONT_CANDIDATES) if (existsSync(f)) return f;
  try {
    const f = execFileSync("fc-match", ["-f", "%{file}", "sans:bold"], { encoding: "utf8", timeout: 3000 }).trim();
    if (f && existsSync(f)) return f;
  } catch { /* no fontconfig */ }
  return null;
}

export const ffmpegBin = (env = process.env) => env.FFMPEG_PATH || "ffmpeg";
export const ffprobeBin = (env = process.env) => env.FFPROBE_PATH || "ffprobe";

export function hasFfmpeg(env = process.env) {
  try {
    execFileSync(ffmpegBin(env), ["-hide_banner", "-version"], { stdio: "ignore", timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

/** Run a program at low CPU priority; rejects with its stderr on failure. */
export function run(bin, args, { timeoutMs = 10 * 60 * 1000, nice = true } = {}) {
  return new Promise((resolve, reject) => {
    const useNice = nice && (existsSync("/usr/bin/nice") || existsSync("/bin/nice"));
    const child = useNice ? spawn("nice", ["-n", "10", bin, ...args], { stdio: ["ignore", "pipe", "pipe"] }) : spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > 1e6) stdout = stdout.slice(-5e5); });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 1e5) stderr = stderr.slice(-5e4); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(bin)} failed (${signal ?? code}): ${stderr.trim().split("\n").slice(-4).join(" | ").slice(0, 600)}`));
    });
  });
}

/** Seconds of a media file by ffprobe, or null. */
export async function probeSeconds(file, env = process.env) {
  try {
    const out = await run(ffprobeBin(env), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeoutMs: 20_000, nice: false });
    const n = Number(out.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** A PNG of the logo at `out`, rasterising SVG when a tool can; else null. */
export async function prepareLogo({ bytes, type, dir }) {
  if (!bytes?.length) return null;
  const out = path.join(dir, "logo.png");
  const src = path.join(dir, `logo-src.${type === "jpeg" ? "jpg" : type}`);
  await writeFile(src, bytes);
  try {
    if (type === "svg") {
      try {
        await run("rsvg-convert", ["-w", "640", "-o", out, src], { timeoutMs: 20_000, nice: false });
        return out;
      } catch { /* no rsvg-convert: try ffmpeg's librsvg */ }
    }
    await run(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vf", "scale='min(640,iw)':-2", "-frames:v", "1", out], { timeoutMs: 20_000, nice: false });
    return out;
  } catch {
    return null;
  }
}

/**
 * Render the promo in `dir`.
 *   scenes: [{ frame, clip?, clipSeconds?, duration, caption, narration, voice?, voiceSeconds? }]
 *   brand:  { name, tagline, host, url, colors: { primary, background, text } }
 * -> { video, srt, duration }
 */
export async function renderPromo({ dir, scenes, music = null, logo = null, brand, vertical = false, threads = Number(process.env.PROMO_FFMPEG_THREADS) || 4, onStep = () => {} }) {
  const font = findFont();
  if (!font) throw new Error("No font for captions (install font-dejavu or set PROMO_FONT)");
  const { W, H } = dimensions(vertical);
  const colors = brand.colors ?? {};
  const timeline = buildTimeline(scenes);
  const segs = [];
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const duration = timeline.segments[i].duration;
    const captionFile = path.join(dir, `caption-${i}.txt`);
    await writeFile(captionFile, wrapText(sc.caption, vertical ? 24 : 38, 2));
    const out = path.join(dir, `seg-${i}.mp4`);
    const args = sc.clip
      ? clipSceneArgs({ clip: sc.clip, clipSeconds: sc.clipSeconds, out, duration, W, H, captionFile: sc.caption ? captionFile : null, font, color: colors.primary, threads })
      : stillSceneArgs({ frame: sc.frame, out, duration, W, H, variant: i, captionFile: sc.caption ? captionFile : null, font, color: colors.primary, threads });
    onStep(`scene ${i + 1}/${scenes.length}`);
    await run(ffmpegBin(), args);
    segs.push(out);
  }
  const nameFile = path.join(dir, "end-name.txt");
  const taglineFile = brand.tagline ? path.join(dir, "end-tagline.txt") : null;
  const urlFile = path.join(dir, "end-url.txt");
  await writeFile(nameFile, wrapText(brand.name, vertical ? 14 : 24, 2));
  if (taglineFile) await writeFile(taglineFile, wrapText(brand.tagline, vertical ? 30 : 52, 2));
  await writeFile(urlFile, String(brand.host || brand.url || "").replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 60));
  const endOut = path.join(dir, "seg-end.mp4");
  onStep("end card");
  await run(ffmpegBin(), endCardArgs({
    out: endOut, W, H,
    background: colors.background ?? "#0a0a0b",
    primary: colors.primary ?? "#14b8a6",
    text: colors.text ?? "#ffffff",
    backdrop: scenes[scenes.length - 1]?.frame ?? null,
    logo, nameFile, taglineFile, urlFile, font, threads
  }));
  segs.push(endOut);

  const voices = scenes.map((sc, i) => (sc.voice ? { file: sc.voice, start: timeline.segments[i].start } : null)).filter(Boolean);
  const video = path.join(dir, "promo.mp4");
  onStep("mixing and encoding");
  await run(ffmpegBin(), finalArgs({ segments: segs, timeline, voices, music, out: video, threads }), { timeoutMs: 15 * 60 * 1000 });
  const srt = path.join(dir, "promo.srt");
  await writeFile(srt, toSrt(scenes.map((sc, i) => {
    const start = timeline.segments[i].start + (sc.voice ? VOICE_LEAD : 0);
    const end = sc.voiceSeconds ? start + sc.voiceSeconds : timeline.segments[i].start + timeline.segments[i].duration - XFADE;
    return { start, end, text: sc.narration || sc.caption };
  })));
  const size = (await stat(video)).size;
  if (size < 10_000) throw new Error("The render came out empty");
  return { video, srt, duration: (await probeSeconds(video)) ?? timeline.total, bytes: size };
}
