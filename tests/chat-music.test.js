import { describe, it, expect } from "vitest";
import {
  DEFAULT_MUSIC_PRICE_MICRO,
  MUSIC_MODEL,
  musicPriceMicro,
  parseMusicCommand,
  validateMusicRequest
} from "@/lib/billing/music";
import { startMusicJob, getMusicJob, takeMusicJob } from "@/lib/chat/music-jobs";

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
    expect(validateMusicRequest({ prompt: " jazz trio " })).toEqual({
      ok: true,
      spec: { prompt: "jazz trio", lyrics: "", duration: 30, model: MUSIC_MODEL }
    });
  });

  it("checks duration, lyrics, seed and junk", () => {
    expect(validateMusicRequest({ prompt: "x", duration: 60, seed: 7, lyrics: "hi" }).spec).toMatchObject({ duration: 60, seed: 7, lyrics: "hi" });
    expect(validateMusicRequest({ prompt: "x", duration: 5 }).ok).toBe(false);
    expect(validateMusicRequest({ prompt: "x", duration: 121 }).ok).toBe(false);
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
    expect(getMusicJob(old, { now: 21 * 60 * 1000 })).toBeNull();
  });
});
