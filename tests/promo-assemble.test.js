import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { endCardArgs, finalArgs, findFont, hasFfmpeg, prepareLogo, renderPromo, stillSceneArgs, buildTimeline } from "@/lib/promo/assemble";
import { runPromo } from "@/lib/promo/pipeline";

const ok = hasFfmpeg() && Boolean(findFont());
const ff = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,sample_rate", "-of", "json", file], { encoding: "utf8" }));

const BRAND = {
  url: "https://c0mpute.com/",
  host: "c0mpute.com",
  name: "c0mpute",
  tagline: "the open compute network",
  description: "Run jobs anywhere.",
  copy: [],
  colors: { primary: "#14b8a6", secondary: "#f97316", accent: "#f97316", background: "#0a0a0b", text: "#ffffff" }
};

describe("ffmpeg argument builders", () => {
  it("chains one xfade per boundary and ducks music under the voice", () => {
    const timeline = buildTimeline([{ duration: 4 }, { duration: 5 }, { duration: 4 }]);
    const args = finalArgs({ segments: ["a.mp4", "b.mp4", "c.mp4", "end.mp4"], timeline, voices: [{ file: "v0.wav", start: 0 }], music: "m.mp3", out: "o.mp4" });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph.match(/xfade=/g)).toHaveLength(3);
    expect(graph).toContain("sidechaincompress");
    expect(graph).toContain("loudnorm=I=-14");
    expect(args).toContain("+faststart");
    expect(args[args.indexOf("-t") + 1]).toBe(String(timeline.total));
  });

  it("refuses filter paths that would need escaping", () => {
    expect(() => stillSceneArgs({ frame: "f.png", out: "o.mp4", duration: 3, W: 1280, H: 720, variant: 0, captionFile: "/x/it's.txt", font: "/f.ttf" })).toThrow(/unsafe/);
    expect(() => endCardArgs({ out: "o.mp4", W: 1280, H: 720, background: "#000000", primary: "#14b8a6", nameFile: "/x/a:b.txt", font: "/f.ttf" })).toThrow(/unsafe/);
  });
});

describe.skipIf(!ok)("promo render with ffmpeg fixtures", () => {
  let dir;
  const fx = {};
  beforeAll(() => {
    dir = mkdtempSync(path.join(process.env.PROMO_TEST_DIR || os.tmpdir(), "promo-fx-"));
    const colors = ["red", "orange", "green", "blue", "purple"];
    colors.forEach((c, i) => {
      ff("-f", "lavfi", "-i", `color=c=${c}:s=896x512`, "-vf", "drawgrid=w=64:h=64:t=2:c=white@0.5", "-frames:v", "1", path.join(dir, `in-${i}.png`));
    });
    ff("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000:duration=1.6", "-ac", "1", "-c:a", "pcm_s16le", path.join(dir, "voice.wav"));
    ff("-f", "lavfi", "-i", "sine=frequency=220:duration=8", "-c:a", "libmp3lame", "-q:a", "6", path.join(dir, "music.mp3"));
    ff("-f", "lavfi", "-i", "color=c=0x14b8a6:s=160x160", "-vf", "format=rgba,pad=256:256:48:48:color=black@0", "-frames:v", "1", path.join(dir, "logo.png"));
    fx.frames = colors.map((_, i) => readFileSync(path.join(dir, `in-${i}.png`)));
    fx.voice = readFileSync(path.join(dir, "voice.wav"));
    fx.music = readFileSync(path.join(dir, "music.mp3"));
    fx.logo = readFileSync(path.join(dir, "logo.png"));
    return () => { if (!process.env.PROMO_KEEP) rmSync(dir, { recursive: true, force: true }); };
  });

  const scenes = (n) => Array.from({ length: n }, (_, i) => ({ visual: `scene ${i} visual of the mascot`, narration: `Narration line ${i}.`, caption: `Caption number ${i} for the scene`, duration: 3 }));

  it("runs the whole pipeline on fake workers and renders an MP4 + SRT", async () => {
    const jobDir = mkdtempSync(path.join(dir, "job-"));
    const job = { id: "11111111-1111-4111-8111-111111111111", dir: jobDir, meta: {} };
    let frameCalls = 0;
    const result = await runPromo(job, { url: BRAND.url, style: "pixar", vertical: false }, {
      brand: async () => ({ ...BRAND, logo: { bytes: fx.logo, type: "png" } }),
      prepareLogo,
      render: renderPromo,
      stream: async function* () {
        yield { type: "done", data: { text: JSON.stringify({ title: "c0mpute", mascot: "a teal robot", scenes: scenes(5) }) } };
      },
      configured: true,
      video: { enabled: true, model: "test", width: 832, height: 480, budgetMs: 2000 },
      gateway: {
        image: async () => fx.frames[frameCalls++ % fx.frames.length],
        tts: async () => fx.voice,
        music: async () => ({ bytes: fx.music, type: "audio/mpeg" }),
        video: async () => { throw Object.assign(new Error("no video worker"), { status: 503 }); }
      }
    });
    expect(result.motion).toBe("kenburns");
    expect(result.frames).toBe(5);
    expect(result.music).toBe(true);
    const info = probe(result.video);
    const v = info.streams.find((s) => s.codec_type === "video");
    const a = info.streams.find((s) => s.codec_type === "audio");
    expect(v).toMatchObject({ codec_name: "h264", width: 1280, height: 720 });
    expect(a).toMatchObject({ codec_name: "aac", sample_rate: "48000" });
    expect(Number(info.format.duration)).toBeGreaterThan(15);
    expect(Math.abs(Number(info.format.duration) - result.duration)).toBeLessThan(0.2);
    const srt = readFileSync(result.srt, "utf8");
    expect(srt).toContain("Narration line 0.");
    expect(srt.match(/-->/g)).toHaveLength(5);
    expect(job.meta.stages.motion.state).toBe("skipped");
    expect(job.meta.stages.render.state).toBe("done");
    expect(job.meta.scenes.every((s) => s.frame)).toBe(true);
  }, 240_000);

  it("renders vertical with img2vid clips, a missing frame and no music", async () => {
    const jobDir = mkdtempSync(path.join(dir, "job-"));
    const clipFile = path.join(dir, "clip.mp4");
    ff("-f", "lavfi", "-i", "testsrc=s=480x832:r=16:d=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", clipFile);
    const clip = readFileSync(clipFile);
    let n = 0;
    const job = { id: "22222222-2222-4222-8222-222222222222", dir: jobDir, meta: {} };
    const result = await runPromo(job, { url: BRAND.url, style: "anime", vertical: true, music: false }, {
      brand: async () => ({ ...BRAND, logo: null }),
      prepareLogo,
      render: renderPromo,
      configured: false,
      video: { enabled: true, model: "test", width: 832, height: 480, budgetMs: 60_000 },
      gateway: {
        image: async () => { n++; if (n === 2) throw new Error("worker died"); return fx.frames[n % 5]; },
        tts: async () => { throw new Error("no tts"); },
        music: async () => { throw new Error("unused"); },
        video: async () => clip
      }
    });
    expect(["img2vid", "mixed"]).toContain(result.motion);
    expect(result.clips).toBeGreaterThan(0);
    expect(result.music).toBe(false);
    const v = probe(result.video).streams.find((s) => s.codec_type === "video");
    expect(v).toMatchObject({ width: 720, height: 1280 });
    expect(job.meta.stages.voice.state).toBe("failed");
    expect(existsSync(result.video)).toBe(true);
  }, 300_000);
});
