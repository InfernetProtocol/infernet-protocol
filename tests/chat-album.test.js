import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/album-writer", async (orig) => {
  const real = await orig();
  return {
    ...real,
    writeAlbumPlan: vi.fn(async ({ tracks }) => ({
      band: "Glass Harbor",
      album: "Night Ferry",
      genre: "synthwave",
      sound: "synthwave, analog pads, female vocals, 100 bpm",
      concept: "A last ferry out of a drowning city.",
      tracks: Array.from({ length: tracks }, (_, i) => ({ n: i + 1, title: `Song ${i + 1}`, theme: "t", vocals: i !== 1, duration: 30 }))
    })),
    writeTrack: vi.fn(async (plan, t) => ({ caption: `${plan.sound}, track ${t.n}`, lyrics: t.vocals ? `[verse]\nline ${t.n}` : "[Instrumental]", duration: t.duration }))
  };
});
vi.mock("@/lib/chat/speech-service", async (orig) => ({
  ...(await orig()),
  // The album cover: a real 2x2 PNG.
  runGatewayJob: vi.fn(async () => ({
    status: 200,
    headers: {},
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64")
  }))
}));
const songAttempts = new Map();
vi.mock("@/lib/chat/music-run", () => ({
  // Every track "renders" at once, except track 3, which always fails, and
  // track 4, whose first attempt finds no worker (it is retried).
  musicRunner: (song) => async () => {
    songAttempts.set(song.title, (songAttempts.get(song.title) ?? 0) + 1);
    if (/track 3\b/.test(song.prompt)) throw Object.assign(new Error("worker died"), { status: 502 });
    if (/track 4\b/.test(song.prompt) && songAttempts.get(song.title) === 1) {
      throw Object.assign(new Error("no worker for music.txt2music/ace-step-1.5 within 2h"), { status: 503 });
    }
    return { audio: new Uint8Array(Buffer.from(`ID3\x03\x00\x00\x00\x00\x00\x00FAKEMP3-${song.title}`, "latin1")), contentType: "audio/mpeg", headers: {} };
  }
}));

import {
  albumCoverPrompt,
  albumFolderName,
  albumSheetText,
  attachmentHeader,
  describeAlbumStage,
  parseAlbumCommand,
  safeFileName,
  trackCountFromPrompt,
  trackFileBase,
  trackLyricsText,
  validateAlbumRequest
} from "@/lib/billing/album";
import { createZip } from "@/lib/zip";
import { id3Tag, stripId3v2, tagMp3 } from "@/lib/id3";
import { creativeDirection, directionNote, parseAlbumPlan, tooSimilar, trackBrief } from "@/lib/album-writer";
import { albumRunner, pool, shouldRetryTrack, trackState } from "@/lib/chat/album-run";
import { albumJobs } from "@/lib/chat/album-jobs";
import { buildAlbumZip, albumEntries } from "@/lib/chat/album-package";

const hasUnzip = (() => {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function unzipList(buf) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "album-test-"));
  try {
    const f = path.join(dir, "a.zip");
    writeFileSync(f, buf);
    execFileSync("unzip", ["-tq", f]);
    return execFileSync("unzip", ["-Z1", f], { encoding: "utf8" }).trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("album commands and requests", () => {
  it("parses /album and /lp", () => {
    expect(parseAlbumCommand("/album dark synthwave about a drowned city")).toEqual({ prompt: "dark synthwave about a drowned city" });
    expect(parseAlbumCommand(" /LP folk ")).toEqual({ prompt: "folk" });
    expect(parseAlbumCommand("/album")).toBeNull();
    expect(parseAlbumCommand("/albums x")).toBeNull();
    expect(parseAlbumCommand("/music x")).toBeNull();
  });

  it("reads a track count from the prompt", () => {
    expect(trackCountFromPrompt("10 songs of punk")).toBe(10);
    expect(trackCountFromPrompt("a nine-track album")).toBe(9);
    expect(trackCountFromPrompt("tracks: 6, jazz")).toBe(6);
    expect(trackCountFromPrompt("jazz in 3/4")).toBeNull();
  });

  it("defaults to 8 tracks and clamps what the prompt asks", () => {
    expect(validateAlbumRequest({ prompt: "punk" })).toEqual({ ok: true, request: { prompt: "punk", tracks: 8 } });
    expect(validateAlbumRequest({ prompt: "ten songs of punk" }).request.tracks).toBe(10);
    expect(validateAlbumRequest({ prompt: "40 songs of punk" }).request.tracks).toBe(12);
    expect(validateAlbumRequest({ prompt: "punk", tracks: 3, duration: 90 }).request).toEqual({ prompt: "punk", tracks: 3, duration: 90 });
    expect(validateAlbumRequest({ prompt: "punk", tracks: 1 }).ok).toBe(false);
    expect(validateAlbumRequest({ prompt: "punk", tracks: 13 }).ok).toBe(false);
    expect(validateAlbumRequest({ prompt: "punk", duration: 601 }).ok).toBe(false);
    expect(validateAlbumRequest({ prompt: " " }).ok).toBe(false);
  });

  it("makes safe file names", () => {
    expect(safeFileName('AC/DC: "Live"?')).toBe("AC DC Live");
    expect(safeFileName("..")).toBe("untitled");
    expect(trackFileBase(3, "Neon / Rain")).toBe("03 - Neon Rain");
    expect(albumFolderName({ band: "Þrøngva", album: "When the Ravens Lied" })).toBe("Þrøngva - When the Ravens Lied");
    expect(attachmentHeader("Þrøngva - X.zip")).toBe(`attachment; filename="_r_ngva - X.zip"; filename*=UTF-8''%C3%9Er%C3%B8ngva%20-%20X.zip`);
  });

  it("writes OpenSong sheets, album.txt and a cover prompt", () => {
    const sheet = trackLyricsText({ band: "B", album: "A", n: 2, total: 8, title: "T", caption: "rock", lyrics: "[verse]\nhey" });
    expect(sheet).toContain("TITLE: T\nARTIST: B\nALBUM: A\nTRACK: 2/8\nSTYLE: rock");
    expect(sheet).toContain("LYRICS:\n[verse]\nhey");
    expect(trackLyricsText({ band: "B", album: "A", n: 1, total: 1, title: "T", lyrics: "" })).toContain("LYRICS:\n[Instrumental]");
    const txt = albumSheetText({ band: "B", album: "A", concept: "C" }, [{ n: 1, title: "One", duration: 125 }, { n: 2, title: "Two", status: "failed" }]);
    expect(txt).toContain("01. One (2:05)");
    expect(txt).toContain("02. Two [not rendered]");
    expect(albumCoverPrompt({ band: "B", album: "A", sound: "rock, 120 bpm" })).toContain('band name "B" and the album title "A"');
  });

  it("describes album progress", () => {
    expect(describeAlbumStage({ stage: "planning", tracksWanted: 8 })).toMatch(/8 songs/);
    expect(describeAlbumStage({ stage: "writing", tracks: [{ lyrics: "x" }, {}] })).toBe("Writing lyrics · 1/2 songs");
    expect(
      describeAlbumStage({ stage: "recording", tracks: [{ status: "done" }, { status: "pending", node: { stage: "rendering" } }, { status: "pending" }, { status: "failed" }] })
    ).toBe("Recording on c0mpute workers · 1/4 done · 1 rendering · 1 waiting for a worker · 1 failed");
  });
});

describe("distinct albums from one brief", () => {
  // 2026-11-15: three runs of one celtic punk prompt gave Raven's Requiem,
  // Ravenstone Rebellion and Ravenstone Rebels, two of them "Electric Highlands".
  it("flags a band or album title that is too close to one already made", () => {
    const avoid = { bands: ["Raven's Requiem", "Ravenstone Rebellion"], albums: ["Electric Highlands"] };
    expect(tooSimilar({ band: "Ravenstone Rebels", album: "New One" }, avoid)).toBe(true);
    expect(tooSimilar({ band: "The Brine Choir", album: "Electric Highlands" }, avoid)).toBe(true);
    expect(tooSimilar({ band: "The Brine Choir", album: "Salt in the Ledger" }, avoid)).toBe(false);
    expect(tooSimilar({ band: "Anything", album: "Else" }, {})).toBe(false);
  });

  it("gives each album its own direction and tells the planner what to avoid", () => {
    let i = 0;
    const seq = [0.01, 0.5, 0.99, 0.3, 0.7, 0.2, 0.8];
    const a = creativeDirection(() => seq[i++ % seq.length]);
    const b = creativeDirection(() => 0.6);
    expect(Object.keys(a)).toEqual(["naming", "setting", "era", "voice", "angle", "art", "palette"]);
    expect(a).not.toEqual(b);
    const note = directionNote(a, { bands: ["Ravenstone Rebellion"], albums: ["Electric Highlands"], songs: ["Battle Cry"] });
    expect(note).toContain(a.setting);
    expect(note).toContain("do NOT reuse or resemble these band names: Ravenstone Rebellion");
    expect(note).toContain("Battle Cry");
  });

  it("draws the cover in the album's own medium and palette", () => {
    const p = albumCoverPrompt({ band: "B", album: "A", sound: "punk", direction: { art: "a linocut print", palette: "teal and coral", setting: "a mining valley", era: "the 1910s" } });
    expect(p).toContain("a linocut print");
    expect(p).toContain("teal and coral");
    expect(p).toContain("a mining valley");
  });

  it("passes a bounded avoid list through the request", () => {
    const r = validateAlbumRequest({ prompt: "celtic punk", avoid: { bands: ["Blackshore Brigade", 7, ""], songs: ["x"] } });
    expect(r.request.avoid).toEqual({ bands: ["Blackshore Brigade"], albums: [], songs: ["x"] });
    expect(validateAlbumRequest({ prompt: "celtic punk" }).request.avoid).toBeUndefined();
  });
});

describe("album plan parsing", () => {
  const reply = JSON.stringify({
    band: "Glass Harbor",
    album: "Night Ferry",
    genre: "synthwave",
    sound: "synthwave",
    concept: "c",
    tracks: [
      { title: "Harbor", theme: "a", vocals: true, duration: 500 },
      { title: "harbor", theme: "b", vocals: false },
      { title: "Third", theme: "c", duration: 90 },
      { title: "Extra" }
    ]
  });

  it("normalises the planner's JSON to the asked count", () => {
    const plan = parseAlbumPlan(`Sure! ${reply}`, 3);
    expect(plan.band).toBe("Glass Harbor");
    expect(plan.tracks.map((t) => t.title)).toEqual(["Harbor", "harbor (II)", "Third"]);
    expect(plan.tracks.map((t) => t.duration)).toEqual([500, 120, 90]);
    expect(plan.tracks[1].vocals).toBe(false);
    expect(parseAlbumPlan(reply, 2, { duration: 45 }).tracks.map((t) => t.duration)).toEqual([45, 45]);
    // A range bounds each track: 500 stays, 90 rises to the floor, the ones with no length take the middle.
    expect(parseAlbumPlan(reply, 4, { range: { min: 150, max: 600 } }).tracks.map((t) => t.duration)).toEqual([500, 375, 150, 375]);
    expect(parseAlbumPlan("no json", 3)).toBeNull();
    expect(parseAlbumPlan('{"band":"x","tracks":[]}', 3)).toBeNull();
  });

  it("mends a dropped value and trailing commas (seen live from llama-3.3-70b)", () => {
    const live =
      '{"band": "Rusty Bolts", "album": "Metal Waves", "genre": "Surf Rock", "sound": "upbeat", "concept": "c", "tracks": [{"title": "Circuit Breaker", "theme": "a", "vocals": true, "duration": 120}, {"title": "Riding the Tide", "theme": "b", "vocals":, "duration": 120},]}';
    const plan = parseAlbumPlan(live, 2, { duration: 20 });
    expect(plan.tracks.map((t) => [t.title, t.vocals, t.duration])).toEqual([
      ["Circuit Breaker", true, 20],
      ["Riding the Tide", true, 20]
    ]);
    const yesNo = parseAlbumPlan('{"band":"B","album":"A","tracks":[{"title":"x","vocals":"no"},{"title":"y","vocals":"yes"}]}', 2);
    expect(yesNo.tracks.map((t) => t.vocals)).toEqual([false, true]);
  });

  it("gives each track's writer the album's context", () => {
    const plan = parseAlbumPlan(reply, 3);
    const brief = trackBrief(plan, plan.tracks[0], "my idea");
    expect(brief).toContain('album "Night Ferry" by Glass Harbor');
    expect(brief).toContain('track 1 of 3, titled "Harbor"');
    expect(brief).toContain("my idea");
  });
});

describe("zip and ID3 writers", () => {
  it.skipIf(!hasUnzip)("writes a zip unzip accepts, with UTF-8 names", () => {
    const zip = createZip([
      { name: "Þrøngva - A/cover.jpg", data: Buffer.from([0xff, 0xd8, 0xff]) },
      { name: "Þrøngva - A/album.txt", data: "hello" }
    ]);
    expect(unzipList(zip)).toEqual(["Þrøngva - A/cover.jpg", "Þrøngva - A/album.txt"]);
  });

  it("refuses unsafe and duplicate names", () => {
    expect(() => createZip([{ name: "../x", data: "" }])).toThrow(/bad zip entry/);
    expect(() => createZip([{ name: "a", data: "" }, { name: "a", data: "" }])).toThrow(/duplicate/);
  });

  it("tags an MP3 with text, lyrics (USLT) and cover (APIC)", () => {
    const tag = id3Tag({ title: "Neon Rain", artist: "B", album: "A", track: 1, total: 8, lyrics: "la la", cover: { bytes: Buffer.from([1, 2, 3]), mime: "image/jpeg" } });
    expect(tag.toString("latin1", 0, 3)).toBe("ID3");
    expect(tag[3]).toBe(3);
    const s = tag.toString("latin1");
    for (const id of ["TIT2", "TPE1", "TALB", "TRCK", "USLT", "APIC"]) expect(s).toContain(id);
    expect(tag.includes(Buffer.from("Neon Rain", "utf16le"))).toBe(true);
    expect(tag.includes(Buffer.from("1/8", "utf16le"))).toBe(true);
    const audio = Buffer.from("AUDIO");
    const tagged = tagMp3(tagMp3(audio, { title: "x" }), { title: "y" });
    expect(stripId3v2(tagged).toString()).toBe("AUDIO");
  });
});

describe("album job", () => {
  it("runs at most n at a time", async () => {
    let now = 0;
    let peak = 0;
    await pool([1, 2, 3, 4, 5], 2, async () => {
      peak = Math.max(peak, ++now);
      await new Promise((r) => setTimeout(r, 5));
      now--;
    });
    expect(peak).toBe(2);
  });

  it("retries a failed track unless it was refused or out of attempts", () => {
    expect(shouldRetryTrack(1, "no worker for music.txt2music/ace-step-1.5 within 2h", 3)).toBe(true);
    expect(shouldRetryTrack(1, "This track was lost in a restart", 3)).toBe(true);
    expect(shouldRetryTrack(3, "worker died", 3)).toBe(false);
    expect(shouldRetryTrack(1, "refused by the content policy", 3)).toBe(false);
    expect(shouldRetryTrack(1, "Out of compute balance", 3)).toBe(false);
  });

  it("treats a track no one has heard of as lost after a few looks", async () => {
    const jobs = { get: () => null, find: async () => null };
    const misses = new Map();
    for (let i = 0; i < 5; i++) expect((await trackState("x", { jobs, misses })).status).toBe("pending");
    expect((await trackState("x", { jobs, misses })).status).toBe("failed");
  });

  it("plans, writes, records every track and packages the zip", async () => {
    const id = albumJobs.start(albumRunner({ prompt: "synthwave", tracks: 4 }, { mode: "free" }, { concurrency: 2, pollMs: 20, retryDelayMs: 10 }), { request: { prompt: "synthwave", tracks: 4 } });
    const deadline = Date.now() + 15_000;
    while (albumJobs.get(id).status === "pending" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const job = albumJobs.get(id);
    expect(job.status).toBe("done");
    expect(job.meta).toMatchObject({ stage: "done", band: "Glass Harbor", album: "Night Ferry", cover: "ready", done: 3, failed: 1 });
    expect(job.meta.tracks.map((t) => t.status)).toEqual(["done", "done", "failed", "done"]);
    expect(job.meta.tracks[2].error).toBe("worker died");
    // Track 3 got all its attempts; track 4 came back on its second.
    expect(songAttempts.get("Song 3")).toBe(3);
    expect(songAttempts.get("Song 4")).toBe(2);
    expect(job.checkpoint.trackAttempts).toEqual([1, 1, 3, 2]);

    const built = await buildAlbumZip(id, { albumJob: job, meta: job.meta });
    expect(built.name).toBe("Glass Harbor - Night Ferry.zip");
    expect(built.tracks).toBe(3);
    const { entries } = albumEntries({ meta: job.meta, audio: [{ bytes: Buffer.from("x"), contentType: "audio/mpeg" }] });
    expect(entries.map((e) => e.name)).toContain("Glass Harbor - Night Ferry/01 - Song 1.mp3");
    if (hasUnzip) {
      const names = unzipList(built.zip);
      expect(names).toEqual(
        expect.arrayContaining([
          "Glass Harbor - Night Ferry/album.txt",
          "Glass Harbor - Night Ferry/01 - Song 1.mp3",
          "Glass Harbor - Night Ferry/01 - Song 1-lyrics.txt",
          "Glass Harbor - Night Ferry/03 - Song 3-lyrics.txt",
          "Glass Harbor - Night Ferry/04 - Song 4.mp3"
        ])
      );
      expect(names).not.toContain("Glass Harbor - Night Ferry/03 - Song 3.mp3");
      expect(names.some((n) => /\/cover\.(jpg|png)$/.test(n))).toBe(true);
    }
  }, 20_000);
});
