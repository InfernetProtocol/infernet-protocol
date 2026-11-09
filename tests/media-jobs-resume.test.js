import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFsStore } from "@/lib/chat/media-store";
import { createDurableJobs } from "@/lib/chat/durable-jobs";
import { createPromoRegistry } from "@/lib/promo/jobs";
import { runPromo } from "@/lib/promo/pipeline";
import { createMusicJobs } from "@/lib/chat/music-jobs";

const tmp = (p) => mkdtempSync(path.join(process.env.PROMO_TEST_DIR || os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

/** A valid mono 16-bit WAV of `secs` seconds. */
function wav(secs = 1, rate = 8000) {
  const data = Buffer.alloc(Math.round(secs * rate) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const BRAND = {
  url: "https://c0mpute.com/", host: "c0mpute.com", name: "c0mpute", tagline: "the open compute network", description: "", copy: [],
  colors: { primary: "#14b8a6", secondary: "#f97316", accent: "#f97316", background: "#0a0a0b", text: "#ffffff" }
};
const STORY = { title: "c0mpute", mascot: "a teal robot", scenes: Array.from({ length: 5 }, (_, i) => ({ visual: `scene ${i} of the mascot in a lab`, narration: `Line ${i}.`, caption: `Caption ${i}`, duration: 3 })) };

/** Fake workers that count every call; `hangFrame` never answers that scene. */
function fakeDeps({ hangFrame = -1, calls }) {
  return {
    brand: async () => { calls.brand++; return { ...BRAND, logo: null }; },
    stream: async function* () { calls.script++; yield { type: "done", data: { text: JSON.stringify(STORY) } }; },
    configured: true,
    video: { enabled: false },
    gateway: {
      image: async (spec) => {
        const i = Number(/scene (\d)/.exec(spec.prompt)?.[1]);
        calls.image.push(i);
        if (i === hangFrame) return new Promise(() => {});
        return PNG;
      },
      tts: async () => { calls.tts++; return wav(1); },
      music: async () => { calls.music++; return { bytes: Buffer.from("ID3fake-mp3"), type: "audio/mpeg" }; },
      video: async () => null
    },
    render: async ({ dir, scenes, music }) => {
      calls.render.push({ frames: scenes.map((s) => Boolean(s.frame)), voices: scenes.filter((s) => s.voice).length, music: Boolean(music) });
      await writeFile(path.join(dir, "promo.mp4"), Buffer.from("fake mp4"));
      await writeFile(path.join(dir, "promo.srt"), "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
      return { video: path.join(dir, "promo.mp4"), srt: path.join(dir, "promo.srt"), duration: 12, bytes: 8 };
    }
  };
}
const newCalls = () => ({ brand: 0, script: 0, image: [], tts: 0, music: 0, render: [] });

describe("media store (directory backend)", () => {
  it("puts, gets, lists and creates atomically", async () => {
    const s = createFsStore(tmp("media-store-"));
    expect(await s.get("promo/a/job.json")).toBeNull();
    expect(await s.put("promo/a/job.json", Buffer.from("{}"))).toBe(true);
    expect((await s.get("promo/a/job.json")).toString()).toBe("{}");
    expect(await s.put("promo/a/lease.json", Buffer.from("1"), { upsert: false })).toBe(true);
    expect(await s.put("promo/a/lease.json", Buffer.from("2"), { upsert: false })).toBe(false);
    expect((await s.list("promo/a")).sort()).toEqual(["job.json", "lease.json"]);
    expect(await s.list("promo")).toEqual(["a"]);
    await s.remove(["promo/a/lease.json"]);
    expect(await s.list("promo/a")).toEqual(["job.json"]);
    await expect(s.put("promo/../x", Buffer.from("x"))).rejects.toThrow(/unsafe/);
  });
});

describe("durable jobs: leases and expiry", () => {
  it("lets one process hold a job until its lease lapses", async () => {
    const store = createFsStore(tmp("media-lease-"));
    let t = 1_000_000;
    const a = createDurableJobs({ kind: "promo", store, owner: "a", now: () => t });
    const b = createDurableJobs({ kind: "promo", store, owner: "b", now: () => t });
    await a.save({ id: "j1", status: "pending", createdAt: t });
    expect(await a.claim("j1")).toBe(true);
    expect(await b.claim("j1")).toBe(false);
    t += 30_000;
    expect(await a.renew("j1")).toBe(true);
    t += 61_000; // a died: its lease lapses
    expect(await b.claim("j1")).toBe(true);
    expect(await a.renew("j1")).toBe(false);
    await b.release("j1");
    expect(await a.claim("j1")).toBe(true);
  });

  it("expires finished jobs after the TTL and fails stuck ones", async () => {
    const store = createFsStore(tmp("media-sweep-"));
    const day = 24 * 60 * 60 * 1000;
    let t = 100 * day;
    const d = createDurableJobs({ kind: "music", store, owner: "a", now: () => t });
    await d.save({ id: "old", status: "done", createdAt: t - 8 * day, finishedAt: t - 8 * day });
    await d.putFile("old", "song.mp3", Buffer.from("x"));
    await d.save({ id: "fresh", status: "done", createdAt: t - day, finishedAt: t - day });
    await d.save({ id: "stuck", status: "pending", createdAt: t - 7 * 60 * 60 * 1000 });
    await d.save({ id: "running", status: "pending", createdAt: t - 60_000 });
    expect(await d.sweep()).toBe(1);
    expect((await d.ids()).sort()).toEqual(["fresh", "running", "stuck"]);
    expect(await d.load("stuck")).toMatchObject({ status: "failed", httpStatus: 504 });
    expect(await d.pending()).toEqual(["running"]);
  });
});

describe("promo jobs survive a restart", () => {
  it("resumes from the last completed stage and never redoes finished work", async () => {
    const store = createFsStore(tmp("promo-store-"));
    const request = { url: BRAND.url, style: "pixar", vertical: false };

    // Process A: brand, script, voice, music and frames 0, 1, 3, 4 land; frame 2 never does.
    const callsA = newCalls();
    const durableA = createDurableJobs({ kind: "promo", store, owner: "A" });
    const regA = createPromoRegistry({ root: tmp("promo-a-"), durable: durableA });
    const id = regA.start((job) => runPromo(job, request, fakeDeps({ hangFrame: 2, calls: callsA })), { request, billing: { mode: "free", userId: null } });
    const rec = await until(async () => {
      const r = await durableA.load(id);
      return r?.checkpoint?.voiceDone && r.checkpoint.music && Object.keys(r.checkpoint.frames ?? {}).length === 4 ? r : null;
    });
    expect(rec).toMatchObject({ status: "pending", request, billing: { mode: "free" } });
    expect((await durableA.files(id)).sort()).toEqual(["frame-0.png", "frame-1.png", "frame-3.png", "frame-4.png", "music.mp3", "voice-0.wav", "voice-1.wav", "voice-2.wav", "voice-3.wav", "voice-4.wav"]);
    // A deploy kills process A here. Its lease lapses a minute later.

    // Process B boots after that, with an empty work dir of its own.
    const callsB = newCalls();
    const durableB = createDurableJobs({ kind: "promo", store, owner: "B", now: () => Date.now() + 2 * 60_000 });
    const regB = createPromoRegistry({ root: tmp("promo-b-"), durable: durableB });
    // Before resuming, B already serves A's progress and frames from the store.
    const seen = await regB.find(id);
    expect(seen).toMatchObject({ status: "pending", remote: true });
    expect(await regB.file(seen, "frame-1.png")).toBeTruthy();

    const resumed = await regB.resumeAll((r) => (job) => runPromo(job, r.request, fakeDeps({ calls: callsB })));
    expect(resumed).toEqual([id]);
    const done = await until(async () => (await durableB.load(id))?.status === "done" && durableB.load(id));
    expect(done.result).toMatchObject({ video: "promo.mp4", srt: "promo.srt", duration: 12 });

    // Only the missing frame was drawn again; nothing else was redone.
    expect(callsB).toMatchObject({ brand: 0, script: 0, tts: 0, music: 0, image: [2] });
    expect(callsB.render).toEqual([{ frames: [true, true, true, true, true], voices: 5, music: true }]);
    expect(done.meta.stages.frames).toMatchObject({ state: "done", detail: "5/5 drawn" });

    // A third process (or B after its own restart) serves the finished promo.
    const regC = createPromoRegistry({ root: tmp("promo-c-"), durable: createDurableJobs({ kind: "promo", store, owner: "C" }) });
    const job = await regC.find(id);
    expect(job.status).toBe("done");
    const mp4 = await regC.file(job, "promo.mp4");
    expect((await import("node:fs")).readFileSync(mp4, "utf8")).toBe("fake mp4");
    // ...and does not try to resume it again.
    expect(await regC.resumeAll(() => { throw new Error("must not run"); })).toEqual([]);
  }, 20_000);

  it("leaves a job alone while its process is alive", async () => {
    const store = createFsStore(tmp("promo-live-"));
    const durableA = createDurableJobs({ kind: "promo", store, owner: "A" });
    const regA = createPromoRegistry({ root: tmp("promo-la-"), durable: durableA });
    const id = regA.start(() => new Promise(() => {}), { request: { url: BRAND.url } });
    await until(async () => (await durableA.load(id))?.status === "pending");
    const regB = createPromoRegistry({ root: tmp("promo-lb-"), durable: createDurableJobs({ kind: "promo", store, owner: "B" }) });
    expect(await regB.resumeAll(() => { throw new Error("must not run"); })).toEqual([]);
  });
});

describe("songs survive a restart", () => {
  it("resumes with the written spec and keeps the song for any process", async () => {
    const store = createFsStore(tmp("music-store-"));
    const a = createMusicJobs({ durable: createDurableJobs({ kind: "music", store, owner: "A" }) });
    let writes = 0;
    const id = a.start(async (job) => {
      writes++;
      job.checkpoint.spec = { prompt: "synthpop", lyrics: "[verse] hi", duration: 30 };
      job.checkpoint.title = "Neon";
      await job.checkpointed();
      return new Promise(() => {}); // the deploy kills it mid-song
    }, { request: { prompt: "synthpop" }, billing: { mode: "balance", userId: "u1" } });
    const durableB = createDurableJobs({ kind: "music", store, owner: "B", now: () => Date.now() + 2 * 60_000 });
    await until(async () => (await durableB.load(id))?.checkpoint?.spec);

    const b = createMusicJobs({ durable: durableB });
    expect(await b.find(id)).toMatchObject({ status: "pending", billing: { mode: "balance", userId: "u1" } });
    let resumedWith = null;
    const ids = await b.resumeAll((rec) => async (job) => {
      resumedWith = { spec: job.checkpoint.spec, title: job.checkpoint.title, resumed: job.resumed, request: rec.request };
      return { audio: new Uint8Array([1, 2, 3]), contentType: "audio/mpeg", headers: { "x-music-model": "ace-step-1.5" } };
    });
    expect(ids).toEqual([id]);
    await until(async () => (await durableB.load(id))?.status === "done");
    expect(writes).toBe(1);
    expect(resumedWith).toEqual({ spec: { prompt: "synthpop", lyrics: "[verse] hi", duration: 30 }, title: "Neon", resumed: true, request: { prompt: "synthpop" } });

    const c = createMusicJobs({ durable: createDurableJobs({ kind: "music", store, owner: "C" }) });
    const rec = await c.find(id);
    expect(rec.result).toMatchObject({ file: "song.mp3", contentType: "audio/mpeg" });
    expect([...(await c.song(rec))]).toEqual([1, 2, 3]);
    c.setCover(id, new Uint8Array([9]));
    await until(async () => (await c.storedCover(id))?.[0] === 9);
  });
});
