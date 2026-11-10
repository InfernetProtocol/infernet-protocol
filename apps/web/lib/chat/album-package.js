import "server-only";

// The album download: one zip with a "Band - Album/" folder holding
//   cover.jpg                      the album cover
//   album.txt                      band, album, concept, track list
//   01 - Title.mp3                 each track, ID3-tagged (title, artist,
//                                  album, track n/N, genre, lyrics, cover)
//   01 - Title-lyrics.txt          each track's OpenSong sheet (style + lyrics)
// Built on demand from the album record and its song jobs, cached briefly.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { albumFolderName, albumSheetText, trackFileBase, trackLyricsText } from "@/lib/billing/album";
import { tagMp3 } from "@/lib/id3";
import { createZip } from "@/lib/zip";
import { ffmpegBin, run } from "@/lib/promo/assemble";
import { musicJobs } from "@/lib/chat/music-jobs";
import { albumJobs } from "@/lib/chat/album-jobs";

const EXT = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/flac": "flac", "audio/ogg": "ogg" };

/** PNG → JPEG bytes with ffmpeg, or null when ffmpeg is missing or fails. */
export async function pngToJpeg(png) {
  let dir = null;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "infernet-album-"));
    const src = path.join(dir, "cover.png");
    const out = path.join(dir, "cover.jpg");
    await writeFile(src, png);
    await run(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-q:v", "2", out], { timeoutMs: 60_000 });
    return await readFile(out);
  } catch (e) {
    console.warn(`[album] cover to jpeg: ${e?.message ?? e}`);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One finished track's audio, from wherever it still is, or null. */
export async function trackAudio(albumJob, i, id) {
  const mem = albumJob?.trackAudio?.[i];
  if (mem?.bytes) return mem;
  if (!id) return null;
  const job = musicJobs.get(id);
  if (job?.status === "done" && job.audio) return { bytes: job.audio, contentType: job.contentType ?? "audio/mpeg" };
  const rec = await musicJobs.find(id);
  if (rec?.status === "done") {
    const bytes = await musicJobs.song(rec);
    if (bytes) return { bytes, contentType: rec.result?.contentType ?? "audio/mpeg" };
  }
  return null;
}

/**
 * The zip's entries from an album's meta (plan + per-track state), the
 * tracks' audio and the cover. Pure apart from the inputs: tested directly.
 */
export function albumEntries({ meta, audio = [], coverJpeg = null, coverPng = null, year = new Date().getFullYear() }) {
  const folder = albumFolderName(meta);
  const tracks = meta.tracks ?? [];
  const total = tracks.length;
  const cover = coverJpeg ? { bytes: coverJpeg, mime: "image/jpeg" } : coverPng ? { bytes: coverPng, mime: "image/png" } : null;
  const entries = [];
  if (coverJpeg) entries.push({ name: `${folder}/cover.jpg`, data: coverJpeg });
  else if (coverPng) entries.push({ name: `${folder}/cover.png`, data: coverPng });
  const rendered = tracks.map((t, i) => ({ ...t, status: audio[i] ? "done" : "failed" }));
  entries.push({ name: `${folder}/album.txt`, data: albumSheetText(meta, rendered) });
  tracks.forEach((t, i) => {
    const base = trackFileBase(t.n, t.title);
    const lyrics = t.lyrics && !/^\s*\[instrumental\]\s*$/i.test(t.lyrics) ? t.lyrics : "";
    entries.push({ name: `${folder}/${base}-lyrics.txt`, data: trackLyricsText({ band: meta.band, album: meta.album, n: t.n, total, title: t.title, caption: t.caption, lyrics: t.lyrics }) });
    const a = audio[i];
    if (!a?.bytes) return;
    const ext = EXT[a.contentType] ?? "mp3";
    const data =
      ext === "mp3"
        ? tagMp3(a.bytes, {
            title: t.title,
            artist: meta.band,
            album: meta.album,
            track: t.n,
            total,
            genre: meta.genre,
            year,
            comment: "Made on c0mpute with ACE-Step 1.5",
            lyrics,
            cover
          })
        : a.bytes;
    entries.push({ name: `${folder}/${base}.${ext}`, data });
  });
  return { folder, entries };
}

const cache = new Map();
const CACHE_MS = 30 * 60 * 1000;

/**
 * { zip: Buffer, name: "Band - Album.zip" } for a finished album, or null.
 * `albumJob` is this process's job (or null) and `meta` the album's meta.
 */
export async function buildAlbumZip(id, { albumJob = null, meta }) {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  const hit = cache.get(id);
  if (hit) return hit.value;
  const value = (async () => {
    const tracks = meta?.tracks ?? [];
    const audio = await Promise.all(tracks.map((t, i) => (t.status === "done" ? trackAudio(albumJob, i, t.id) : null)));
    const coverPng = albumJobs.getCover(id) ?? (await albumJobs.storedCover(id));
    const coverJpeg = coverPng ? await pngToJpeg(Buffer.from(coverPng)) : null;
    const { folder, entries } = albumEntries({ meta, audio, coverJpeg, coverPng: coverPng ? Buffer.from(coverPng) : null });
    return { zip: createZip(entries), name: `${folder}.zip`, tracks: audio.filter(Boolean).length, cover: Boolean(coverPng) };
  })();
  cache.set(id, { at: now, value });
  // Keep at most two built zips (tens of MB each) in memory.
  while (cache.size > 2) cache.delete(cache.keys().next().value);
  // The image queue can be slower than the songs: a zip built before the
  // cover landed is not kept, so the next download picks the cover up.
  value.then((v) => !v.cover && cache.delete(id), () => cache.delete(id));
  return value;
}
