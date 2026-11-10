import { describe, it, expect } from "vitest";
import {
  DEFAULT_STYLE,
  detectPromoRequest,
  normalizeStyle,
  parsePromoCommand,
  promoPriceMicro,
  validatePromoRequest,
  describePromoProgress
} from "@/lib/promo/request";
import {
  MAX_SCENES,
  fallbackStoryboard,
  musicCaption,
  parseStoryboard,
  scenePrompt,
  seedFor,
  writeStoryboard
} from "@/lib/promo/storyboard";
import { buildTimeline, toSrt, wavSeconds, wrapText, XFADE, END_CARD_SECONDS } from "@/lib/promo/assemble";
import { parseRange, publicJob, createPromoRegistry } from "@/lib/promo/jobs";

const { brandPalette, extractCopy, sniffImage } = await import("@/lib/promo/brand");
const { fetchPublic, isPrivateAddress } = await import("@/lib/site-brief");

const BRAND = {
  url: "https://c0mpute.com/",
  host: "c0mpute.com",
  name: "c0mpute",
  tagline: "the open compute network",
  description: "Run jobs anywhere, sell unused compute.",
  copy: ["Run jobs anywhere", "Sell your unused compute to the network", "Pay only for verified work"],
  colors: { primary: "#14b8a6", secondary: "#f97316", accent: "#f97316", background: "#0a0a0b", text: "#ffffff" }
};

const scene = (n, extra = {}) => ({ visual: `the mascot does thing number ${n} in a sunny lab`, narration: `Line ${n} of the voice-over.`, caption: `Caption ${n}`, duration: 5, ...extra });

describe("promo commands", () => {
  it("parses /promo with style and vertical", () => {
    expect(parsePromoCommand("/promo https://c0mpute.com pixar style")).toMatchObject({ url: "https://c0mpute.com", style: "pixar", vertical: false });
    expect(parsePromoCommand("/promo https://example.com/app anime vertical")).toMatchObject({ url: "https://example.com/app", style: "anime", vertical: true });
    expect(parsePromoCommand("/promo c0mpute.com claymation 9:16")).toMatchObject({ url: "https://c0mpute.com", style: "claymation", vertical: true });
    expect(parsePromoCommand("/promo https://x.io")).toMatchObject({ style: DEFAULT_STYLE });
    expect(parsePromoCommand("/promo make something")).toBeNull();
    expect(parsePromoCommand("/promotion https://x.io")).toBeNull();
  });

  it("routes plain-language promo asks with a link, and nothing else", () => {
    expect(detectPromoRequest("create a pixar style promo video for https://c0mpute.com")).toMatchObject({ url: "https://c0mpute.com", style: "pixar" });
    expect(detectPromoRequest("can you make a cartoon demo video of https://infernetprotocol.com?")).toMatchObject({ url: "https://infernetprotocol.com" });
    expect(detectPromoRequest("make an explainer video for c0mpute.com, stop-motion look")).toMatchObject({ url: "https://c0mpute.com", style: "claymation" });
    expect(detectPromoRequest("summarize https://c0mpute.com")).toBeNull();
    expect(detectPromoRequest("what is a promo video?")).toBeNull();
    expect(detectPromoRequest("/image a promo poster for https://x.com")).toBeNull();
  });

  it("normalizes styles", () => {
    expect(normalizeStyle("Pixar")).toBe("pixar");
    expect(normalizeStyle("flat 2D")).toBe("flat");
    expect(normalizeStyle("stop motion")).toBe("claymation");
    expect(normalizeStyle("nonsense")).toBe(DEFAULT_STYLE);
  });

  it("validates requests and refuses non-http urls", () => {
    expect(validatePromoRequest({ url: "c0mpute.com" })).toMatchObject({ ok: true, request: { url: "https://c0mpute.com/", style: "pixar", vertical: false, voice: "af_bella", music: true } });
    expect(validatePromoRequest({ url: "https://a.com", style: "anime", vertical: true, voice: "am_onyx" }).request).toMatchObject({ style: "anime", vertical: true, voice: "am_onyx" });
    expect(validatePromoRequest({ url: "https://a.com", voice: "nope" }).request.voice).toBe("af_bella");
    expect(validatePromoRequest({ url: "ftp://a.com" }).ok).toBe(false);
    expect(validatePromoRequest({ url: "file:///etc/passwd" }).ok).toBe(false);
    expect(validatePromoRequest({ url: "https://user:pw@a.com" }).ok).toBe(false);
    expect(validatePromoRequest({ url: "http://localhost:3000" }).ok).toBe(false);
    expect(validatePromoRequest({}).ok).toBe(false);
  });

  it("prices from the work done", () => {
    expect(promoPriceMicro({ frames: 6, music: true, clips: 0 }, {})).toBe(3000 + 6 * 2000 + 5000);
    expect(promoPriceMicro({ frames: 6, music: false, clips: 6 }, {})).toBe(3000 + 6 * 2000 + 6 * 10000);
    expect(promoPriceMicro({ frames: 1 }, { INFERNET_PROMO_BASE_MICRO: "0", INFERNET_IMAGE_PRICE_MICRO: "1" })).toBe(1);
  });

  it("describes progress per stage", () => {
    const text = describePromoProgress({ stages: { brand: { state: "done", detail: "c0mpute" }, script: { state: "running" } } });
    expect(text.split("\n")).toHaveLength(7);
    expect(text).toContain("✓ Brand: c0mpute");
    expect(text).toContain("… Script");
  });
});

describe("storyboard JSON", () => {
  it("accepts a valid reply wrapped in prose and fences", () => {
    const reply = "Sure!\n```json\n" + JSON.stringify({ title: "T", tagline: "Go", mascot: "a teal robot", music: "pop", scenes: [1, 2, 3, 4, 5, 6].map((n) => scene(n)) }) + "\n```";
    const sb = parseStoryboard(reply, { brand: BRAND });
    expect(sb.scenes).toHaveLength(6);
    expect(sb.mascot).toBe("a teal robot");
    const total = sb.scenes.reduce((a, s) => a + s.duration, 0);
    expect(total).toBeGreaterThanOrEqual(20);
    expect(total).toBeLessThanOrEqual(40.5);
  });

  it("rejects too few scenes, junk and non-JSON", () => {
    expect(parseStoryboard({ scenes: [scene(1), scene(2)] })).toBeNull();
    expect(parseStoryboard("no json here")).toBeNull();
    expect(parseStoryboard("{broken")).toBeNull();
    expect(parseStoryboard({ scenes: [1, 2, 3, 4, 5].map(() => ({ visual: "x" })) })).toBeNull();
  });

  it("clips text, caps scenes and clamps durations into 20-40 s", () => {
    const long = "word ".repeat(200);
    const sb = parseStoryboard({ scenes: Array.from({ length: 12 }, (_, i) => scene(i, { narration: long, caption: long, duration: 30 })) });
    expect(sb.scenes).toHaveLength(MAX_SCENES);
    for (const s of sb.scenes) {
      expect(s.narration.length).toBeLessThanOrEqual(180);
      expect(s.caption.length).toBeLessThanOrEqual(70);
      expect(s.duration).toBeGreaterThanOrEqual(3);
      expect(s.duration).toBeLessThanOrEqual(7);
    }
    const short = parseStoryboard({ scenes: [1, 2, 3, 4, 5].map((n) => scene(n, { duration: 1 })) });
    expect(short.scenes.reduce((a, s) => a + s.duration, 0)).toBeGreaterThanOrEqual(15);
  });

  it("replaces em dashes and newlines", () => {
    const sb = parseStoryboard({ scenes: [1, 2, 3, 4, 5].map((n) => scene(n, { narration: "Fast—and\nfree" })) });
    expect(sb.scenes[0].narration).toBe("Fast, and free");
  });

  it("builds style-locked keyframe prompts without asking for lettering", () => {
    const sb = parseStoryboard({ mascot: "a teal robot with an orange scarf", scenes: [1, 2, 3, 4, 5].map((n) => scene(n, { visual: `scene ${n} with the c0mpute logo on a sign` })) });
    const p0 = scenePrompt(sb, 0, { style: "pixar", colors: BRAND.colors });
    const p1 = scenePrompt(sb, 1, { style: "pixar", colors: BRAND.colors });
    expect(p0.startsWith("Pixar-style 3D animated film still")).toBe(true);
    expect(p0.split(".")[0]).toBe(p1.split(".")[0]);
    expect(p0).toContain("a teal robot with an orange scarf");
    expect(p0).toContain("#14b8a6");
    expect(p0).toMatch(/No text, no letters/);
    expect(p0).not.toMatch(/\blogo on/);
    expect(p0.length).toBeLessThanOrEqual(1900);
  });

  it("falls back to a rule storyboard that validates", async () => {
    const fb = fallbackStoryboard({ brand: BRAND, style: "pixar" });
    expect(parseStoryboard(fb, { brand: BRAND })).not.toBeNull();
    expect(fb.scenes[1].narration).toContain("c0mpute");
    const out = await writeStoryboard({ brand: BRAND, style: "pixar" }, { configured: false });
    expect(out.writer).toBe("rules");
    const bad = await writeStoryboard({ brand: BRAND, style: "pixar" }, {
      stream: async function* () { yield { type: "done", data: { text: "nope" } }; }
    });
    expect(bad.writer).toBe("rules");
    const good = await writeStoryboard({ brand: BRAND, style: "pixar" }, {
      stream: async function* () { yield { type: "done", data: { text: JSON.stringify({ scenes: [1, 2, 3, 4, 5].map((n) => scene(n)) }) } }; }
    });
    expect(good.writer).toBe("model");
  });

  it("asks for an instrumental soundtrack and a stable seed", () => {
    expect(musicCaption({ music: "synthwave, vocals" }, "pixar")).toMatch(/^synthwave, .*instrumental, no vocals/);
    expect(musicCaption({}, "anime")).toContain("J-pop");
    expect(seedFor("c0mpute.com|pixar")).toBe(seedFor("c0mpute.com|pixar"));
    expect(seedFor("a")).not.toBe(seedFor("b"));
  });
});

describe("timeline, captions and audio helpers", () => {
  it("stretches scenes to fit narration and chains crossfades", () => {
    const t = buildTimeline([{ duration: 4 }, { duration: 4, voiceSeconds: 5 }, { duration: 5 }]);
    expect(t.segments).toHaveLength(4);
    expect(t.segments[1].duration).toBeCloseTo(5 + 0.3 + 0.6 + XFADE);
    expect(t.offsets[0]).toBeCloseTo(4 - XFADE);
    expect(t.total).toBeCloseTo(4 + 6.4 + 5 + END_CARD_SECONDS - 3 * XFADE);
  });

  it("writes SRT", () => {
    const srt = toSrt([{ start: 0.3, end: 2.5, text: "Hello there" }, { start: 61, end: 62.25, text: "Bye" }]);
    expect(srt).toBe("1\n00:00:00,300 --> 00:00:02,500\nHello there\n\n2\n00:01:01,000 --> 00:01:02,250\nBye\n");
  });

  it("wraps captions", () => {
    expect(wrapText("one two three four five six", 9, 2)).toBe("one two\nthree...");
    expect(wrapText("short", 20)).toBe("short");
  });

  it("reads WAV length", () => {
    const rate = 24000;
    const data = Buffer.alloc(rate * 2 * 2); // 2 s mono 16-bit
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
    h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write("data", 36); h.writeUInt32LE(data.length, 40);
    expect(wavSeconds(Buffer.concat([h, data]))).toBeCloseTo(2);
    expect(wavSeconds(Buffer.from("nope"))).toBeNull();
  });

  it("parses byte ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=2000-3000", 1000)).toEqual({ invalid: true });
    expect(parseRange(null, 1000)).toBeNull();
  });
});

describe("promo jobs", () => {
  it("never shows server paths and exposes the video when done", async () => {
    const root = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "promo-reg-"));
    const reg = createPromoRegistry({ root });
    const id = reg.start(async (job) => {
      job.meta = { stage: "render" };
      return { video: `${job.dir}/promo.mp4`, srt: `${job.dir}/promo.srt`, duration: 31.24, bytes: 123 };
    });
    await new Promise((r) => setTimeout(r, 10));
    const pub = publicJob(reg.get(id));
    expect(pub).toMatchObject({ status: "done", video: `/api/chat/promo/${id}/video`, captions: `/api/chat/promo/${id}/captions`, duration: 31.2 });
    expect(JSON.stringify(pub)).not.toContain(root);
    reg.drop(id);
  });
});

describe("brand reading and the SSRF guard", () => {
  it("refuses private and loopback targets before connecting", async () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    await expect(fetchPublic("http://127.0.0.1:9/")).rejects.toThrow(/public/);
    await expect(fetchPublic("http://[::1]/")).rejects.toThrow(/public/);
    await expect(fetchPublic("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/public/);
    await expect(fetchPublic("file:///etc/passwd")).rejects.toThrow(/http/);
    // A name that resolves to loopback is refused at connect time.
    await expect(fetchPublic("http://localhost:9/", { timeoutMs: 2000 })).rejects.toThrow(/public/i);
  });

  it("picks a palette from theme, accents and the manifest", () => {
    expect(brandPalette({ colors: { theme: "#0a0a0b", accents: ["#14b8a6", "#f97316"], scheme: "dark" }, manifest: { background_color: "#0a0a0b" } })).toMatchObject({
      primary: "#14b8a6", secondary: "#f97316", background: "#0a0a0b", text: "#ffffff", scheme: "dark"
    });
    expect(brandPalette({})).toMatchObject({ primary: "#14b8a6", background: "#ffffff", text: "#111111" });
  });

  it("extracts headline copy and skips chrome", () => {
    const html = `<nav><a>Home</a><h2>Menu heading</h2></nav><h1>The open compute network</h1><p>We accept cookies for javascript</p>
      <p>Run jobs anywhere and sell unused compute to people and AI agents.</p><script>var h1 = "<h1>no</h1>"</script><h2>The open compute network</h2>`;
    expect(extractCopy(html)).toEqual(["The open compute network", "Run jobs anywhere and sell unused compute to people and AI agents."]);
  });

  it("sniffs image types", () => {
    expect(sniffImage(Buffer.from("89504e470d0a1a0a0000000000", "hex"))).toBe("png");
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("svg");
    expect(sniffImage(Buffer.from("<html><body>not an image</body></html>"))).toBeNull();
  });
});

describe("no video worker does not hold promo slots", () => {
  const wav = () => {
    const data = Buffer.alloc(16000);
    const head = Buffer.alloc(44);
    head.write("RIFF", 0, "latin1"); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8, "latin1");
    head.write("fmt ", 12, "latin1"); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
    head.writeUInt32LE(8000, 24); head.writeUInt32LE(16000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
    head.write("data", 36, "latin1"); head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
  };

  it("probes briefly once, then every promo for half an hour skips img2vid at once", async () => {
    const { runPromo, resetVideoWorkerState, videoWorkersMissing } = await import("@/lib/promo/pipeline");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    resetVideoWorkerState();
    const waits = [];
    const deps = {
      brand: async (url) => ({ name: "Killer Cloud", tagline: "Hosting", host: "cloud.killer.pit.world", url, colors: { primary: "#112233", secondary: "#445566", accent: "#778899" }, copy: [] }),
      configured: false,
      gateway: {
        image: async () => Buffer.alloc(64, 1),
        tts: async () => wav(),
        music: async () => null,
        video: async (_spec, { maxWaitS }) => {
          waits.push(maxWaitS);
          throw Object.assign(new Error("img2vid failed (gateway HTTP 503): no worker for video.img2vid within 3 min"), { status: 503 });
        }
      },
      video: { enabled: true, model: "wan2.2-ti2v-5b", width: 832, height: 480, budgetMs: 20 * 60 * 1000, probeMs: 180 * 1000 },
      render: async ({ dir }) => ({ video: `${dir}/promo.mp4`, srt: `${dir}/promo.srt`, duration: 30, bytes: 1 })
    };
    const run = async () => {
      const dir = await mkdtemp(join(tmpdir(), "promo-test-"));
      try {
        const job = { id: "j", dir, meta: {} };
        await runPromo(job, { url: "https://cloud.killer.pit.world", music: false }, deps);
        return job.meta.stages.motion;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };
    expect((await run()).state).toBe("skipped");
    expect(waits).toEqual([180]);
    expect(videoWorkersMissing()).toBe(true);
    expect((await run()).state).toBe("skipped");
    expect(waits).toEqual([180]);
    resetVideoWorkerState();
  }, 30_000);
});
