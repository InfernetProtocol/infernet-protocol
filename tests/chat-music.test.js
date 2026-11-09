import { describe, it, expect } from "vitest";
import {
  DEFAULT_MUSIC_PRICE_MICRO,
  MUSIC_MODEL,
  musicPriceMicro,
  parseMusicCommand,
  validateMusicRequest
} from "@/lib/billing/music";
import { startMusicJob, getMusicJob, takeMusicJob, MUSIC_JOB_TTL_MS } from "@/lib/chat/music-jobs";

describe("chat music helpers", () => {
  it("parses /music and /song, with optional lyrics", () => {
    expect(parseMusicCommand("/music lo-fi hip hop")).toEqual({ prompt: "lo-fi hip hop", lyrics: "" });
    expect(parseMusicCommand(" /SONG synthpop ")).toEqual({ prompt: "synthpop", lyrics: "" });
    expect(parseMusicCommand("/music synthpop, female vocals\nlyrics:\n[verse]\nneon lights")).toEqual({
      prompt: "synthpop, female vocals",
      lyrics: "[verse]\nneon lights"
    });
    expect(parseMusicCommand("/music folk\n\n[chorus]\nla la")).toEqual({ prompt: "folk", lyrics: "[chorus]\nla la" });
    expect(parseMusicCommand("make music")).toBeNull();
    expect(parseMusicCommand("/music")).toBeNull();
    expect(parseMusicCommand("/musical theatre")).toBeNull();
  });

  it("defaults to a 30 s instrumental ACE-Step job", () => {
    expect(validateMusicRequest({ prompt: " jazz trio " })).toMatchObject({
      ok: true,
      spec: { prompt: "jazz trio", lyrics: "", duration: 30, model: MUSIC_MODEL }
    });
  });

  it("checks duration, lyrics, seed and junk", () => {
    expect(validateMusicRequest({ prompt: "x", duration: 60, seed: 7, lyrics: "hi" }).spec).toMatchObject({ duration: 60, seed: 7, lyrics: "hi" });
    expect(validateMusicRequest({ prompt: "x", duration: 5 }).ok).toBe(false);
    expect(validateMusicRequest({ prompt: "x", duration: 181 }).ok).toBe(false);
    expect(validateMusicRequest({ prompt: "x", duration: 30.5 }).ok).toBe(false);
    expect(validateMusicRequest({ prompt: "x", lyrics: "y".repeat(100_001) }).ok).toBe(false);
    expect(validateMusicRequest({ prompt: "x".repeat(100_001) }).ok).toBe(false);
    expect(validateMusicRequest({ prompt: "x", seed: -1 }).ok).toBe(false);
    expect(validateMusicRequest({ prompt: "" }).ok).toBe(false);
    expect(validateMusicRequest(null).ok).toBe(false);
  });

  it("accepts 100k-character prompts and lyrics, clipping what the model cannot read", () => {
    const long = "word ".repeat(19_999) + "word";
    expect(long.length).toBe(99_999);
    const r = validateMusicRequest({ prompt: long, lyrics: long });
    expect(r.ok).toBe(true);
    expect(r.spec.prompt.length).toBeLessThanOrEqual(1000);
    expect(r.spec.prompt.length).toBeGreaterThan(800);
    expect(r.spec.prompt.endsWith("word")).toBe(true);
    expect(r.spec.lyrics.length).toBeLessThanOrEqual(4000);
    expect(validateMusicRequest({ prompt: "short" }).spec.prompt).toBe("short");
  });

  it("prices a track flat, overridable by env", () => {
    expect(musicPriceMicro({})).toBe(DEFAULT_MUSIC_PRICE_MICRO);
    expect(musicPriceMicro({ INFERNET_MUSIC_PRICE_MICRO: "1200" })).toBe(1200);
    expect(musicPriceMicro({ INFERNET_MUSIC_PRICE_MICRO: "nope" })).toBe(DEFAULT_MUSIC_PRICE_MICRO);
  });
});

import { durationFromBrief, toGatewaySpec } from "@/lib/billing/music";
import { parseWriterReply, writeMusicSpec } from "@/lib/music-brief-writer";

const BRIEF =
  "Aggressive Celtic folk punk fused with gritty old-school boom-bap hip-hop and heavy rap-rock. 150-second song, 104 BPM, E minor, 4/4. " +
  "Fierce Irish fiddle riffs ... Structure: 8-second instrumental intro, rap verse, explosive singalong chorus ... Full song with vocals and lyrics, 2–3 minutes.";

describe("music briefs", () => {
  it("reads the length a brief asks for", () => {
    expect(durationFromBrief(BRIEF)).toBe(150);
    expect(durationFromBrief("a ballad, 2-3 minutes")).toBe(180);
    expect(durationFromBrief("2.5 min of ambient")).toBe(150);
    expect(durationFromBrief("90 sec jingle")).toBe(90);
    expect(durationFromBrief("104 BPM in 4/4")).toBeNull();
  });

  it("keeps the full brief for the writer and clips only the gateway spec", () => {
    const long = "x ".repeat(3000).trim();
    const r = validateMusicRequest({ prompt: long });
    expect(r.request.prompt).toBe(long);
    expect(r.request.duration).toBeNull();
    expect(r.spec.prompt.length).toBeLessThanOrEqual(1000);
    expect(toGatewaySpec({ prompt: "p", lyrics: "", duration: 500 }).duration).toBe(180);
  });

  it("parses the writer's JSON, tolerating chatter around it", () => {
    const out = parseWriterReply('Sure!\n{"caption":"celtic punk, fiddle, rap, 104 bpm","lyrics":"[verse]\\nraise it up","duration":150}\nEnjoy');
    expect(out).toEqual({ title: null, caption: "celtic punk, fiddle, rap, 104 bpm", lyrics: "[verse]\nraise it up", duration: 150 });
    expect(parseWriterReply("no json here")).toBeNull();
    expect(parseWriterReply('{"caption":"x"}')).toBeNull();
  });

  it("turns a lyric-less brief into caption + lyrics, and the brief's own length wins", async () => {
    async function* stream() {
      yield { type: "done", data: { text: '{"caption":"celtic folk punk, boom-bap, rap-rock, fiddle, 104 bpm, E minor","lyrics":"[verse]\\nwe drink to the fight","duration":95}' } };
    }
    const r = await writeMusicSpec({ prompt: BRIEF, lyrics: "", duration: null }, { stream, configured: true });
    expect(r.writer).toBe("model");
    expect(r.lyrics).toContain("[verse]");
    expect(r.prompt).toContain("celtic folk punk");
    expect(r.duration).toBe(150); // the brief's "150-second song" beats the model's 95
  });

  it("falls back to the brief, instrumental, when the writer fails", async () => {
    async function* stream() {
      yield { type: "error", data: { message: "down" } };
    }
    const r = await writeMusicSpec({ prompt: "lofi beats, 45 seconds", lyrics: "", duration: null }, { stream, configured: true });
    expect(r).toEqual({ prompt: "lofi beats, 45 seconds", lyrics: "", duration: 45, writer: "rules" });
    const own = await writeMusicSpec({ prompt: "folk", lyrics: "[verse]\nmine", duration: 40 }, { configured: true });
    expect(own).toEqual({ prompt: "folk", lyrics: "[verse]\nmine", duration: 40, writer: "none" });
  });
});

import { describeNodeProgress } from "@/lib/billing/music";

import { coverArtPrompt } from "@/lib/billing/music";
import { getMusicCover, setMusicCover } from "@/lib/chat/music-jobs";

describe("cover art", () => {
  it("builds a square album-cover prompt with the title as the only lettering", () => {
    const p = coverArtPrompt({ caption: "Celtic folk punk, boom-bap, fiddle, 104 BPM, E minor, 4/4", title: 'Pints & "Rebellion"' });
    expect(p).toContain("album cover");
    expect(p).toContain("Celtic folk punk");
    expect(p).not.toMatch(/104 BPM|E minor|4\/4/);
    expect(p).toContain('title "Pints & Rebellion"');
    expect(coverArtPrompt({ caption: "lofi", title: null })).toContain("No text");
  });

  it("keeps covers apart from the song job, until they expire", () => {
    setMusicCover("c1", new Uint8Array([1]), { now: 0 });
    expect(getMusicCover("c1", { now: 1000 })).toEqual(new Uint8Array([1]));
    // A song may sit in the gateway's queue for up to 2 h: still kept at 90 min.
    expect(getMusicCover("c1", { now: 90 * 60 * 1000 })).toEqual(new Uint8Array([1]));
    expect(getMusicCover("c1", { now: MUSIC_JOB_TTL_MS + 1 })).toBeNull();
    expect(getMusicCover("nope")).toBeNull();
  });

  it("the writer retries once when the model call fails", async () => {
    let calls = 0;
    async function* stream() {
      calls += 1;
      if (calls === 1) {
        yield { type: "error", data: { message: "getaddrinfo EAI_AGAIN" } };
        return;
      }
      yield { type: "done", data: { text: '{"title":"Second Try","caption":"dark synthwave, analog bass","lyrics":"[verse]\\nneon","duration":30}' } };
    }
    const r = await writeMusicSpec({ prompt: "dark synthwave", lyrics: "", duration: null }, { stream, configured: true });
    expect(calls).toBe(2);
    expect(r).toMatchObject({ writer: "model", title: "Second Try" });
  });

  it("the writer names the song", async () => {
    async function* stream() {
      yield { type: "done", data: { text: '{"title":"Pints of Rebellion","caption":"celtic punk, fiddle, rap","lyrics":"[verse]\\nraise it","duration":90}' } };
    }
    const r = await writeMusicSpec({ prompt: "celtic punk rap song", lyrics: "", duration: null }, { stream, configured: true });
    expect(r.title).toBe("Pints of Rebellion");
  });
});

describe("node progress line", () => {
  it("names the node, its ETA, queueing and retries", () => {
    expect(describeNodeProgress({ stage: "rendering", worker: "12D3KooWG9TmqCHN63oFoxb2bwTGRYqwW8e1C2Ua9e14XtPja8R9", eta_s: 600, stage_elapsed_s: 125 }))
      .toBe("Rendering on node …XtPja8R9 · 2:05 in · ~7:55 left (node's estimate)");
    expect(describeNodeProgress({ stage: "rendering", worker: "abcdefgh12345678", eta_s: 60, stage_elapsed_s: 90 })).toContain("past the node's estimate");
    expect(describeNodeProgress({ stage: "queued", stage_elapsed_s: 61 })).toBe("Queued for a c0mpute music worker · 1:01");
    expect(describeNodeProgress({ stage: "queued", stage_elapsed_s: 5, queue_position: 2 })).toBe("Queued for a c0mpute music worker (#2 in line) · 0:05");
    expect(describeNodeProgress({ stage: "finding_worker", attempt: 2 })).toBe("Finding a c0mpute music worker (attempt 2)");
    expect(describeNodeProgress({ stage: "retrying", detail: "no worker" })).toBe("The worker failed (no worker); trying another worker");
    expect(describeNodeProgress(null)).toBe("Composing on a c0mpute worker");
  });
});

import { createServer } from "node:http";
import { awaitGatewayResult } from "@/lib/chat/speech-service";

describe("songs survive an app restart (gateway /v1/result)", () => {
  it("waits through 202s, returns the finished song, and null for an unknown id", async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      if (req.url === "/v1/result/song-1") {
        calls += 1;
        if (calls < 3) { res.writeHead(202, { "content-type": "application/json" }); res.end('{"stage":"rendering"}'); return; }
        res.writeHead(200, { "content-type": "audio/mpeg", "x-c0mpute-worker-peer-id": "w1" });
        res.end(Buffer.from("ID3-song"));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"no such request"}');
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const prev = { url: process.env.C0MPUTE_SPEECH_URL, token: process.env.C0MPUTE_SPEECH_TOKEN };
    process.env.C0MPUTE_SPEECH_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.C0MPUTE_SPEECH_TOKEN = "tok";
    try {
      const r = await awaitGatewayResult("song-1", { everyMs: 5, timeoutMs: 5000 });
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toBe("audio/mpeg");
      expect(r.body.toString()).toBe("ID3-song");
      expect(calls).toBe(3);
      expect(await awaitGatewayResult("nope", { everyMs: 5, timeoutMs: 1000 })).toBeNull();
    } finally {
      process.env.C0MPUTE_SPEECH_URL = prev.url;
      process.env.C0MPUTE_SPEECH_TOKEN = prev.token;
      server.close();
    }
  });
});

describe("chat music job registry", () => {
  it("reports pending, then hands the audio out exactly once", async () => {
    let finish;
    const id = startMusicJob(() => new Promise((r) => { finish = r; }));
    expect(getMusicJob(id).status).toBe("pending");
    await new Promise((r) => setTimeout(r, 0));
    finish({ audio: new Uint8Array([9]), contentType: "audio/mpeg", headers: { "x-music-model": MUSIC_MODEL } });
    await new Promise((r) => setTimeout(r, 0));
    const done = takeMusicJob(id);
    expect(done).toMatchObject({ status: "done", contentType: "audio/mpeg", headers: { "x-music-model": MUSIC_MODEL } });
    expect(done.audio).toEqual(new Uint8Array([9]));
    expect(getMusicJob(id)).toBeNull();
  });

  it("keeps the error and its status, and expires", async () => {
    const id = startMusicJob(async () => { throw Object.assign(new Error("No worker"), { status: 503 }); });
    await new Promise((r) => setTimeout(r, 0));
    expect(getMusicJob(id)).toMatchObject({ status: "failed", error: "No worker", httpStatus: 503 });
    const old = startMusicJob(() => new Promise(() => {}), { now: 0 });
    expect(getMusicJob(old, { now: 90 * 60 * 1000 })).not.toBeNull();
    expect(getMusicJob(old, { now: MUSIC_JOB_TTL_MS + 1 })).toBeNull();
  });
});
