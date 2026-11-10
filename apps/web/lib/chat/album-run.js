import "server-only";

// The /chat album job: plan (band, album, track titles), cover art, lyrics
// for every track, then each track as its own song job (music-run.js) a few
// at a time. Every stage is checkpointed on job.checkpoint, so a deploy
// mid-album resumes it where it was: the plan and lyrics are kept, tracks
// already started are picked up by id (their song jobs resume on their own).

import { runGatewayJob } from "@/lib/chat/speech-service";
import { IMAGE_MODEL, IMAGE_SIZES } from "@/lib/billing/image";
import { albumCoverPrompt } from "@/lib/billing/album";
import { writeAlbumPlan, writeTrack } from "@/lib/album-writer";
import { musicJobs, startMusicJob } from "@/lib/chat/music-jobs";
import { musicRunner } from "@/lib/chat/music-run";
import { albumJobs } from "@/lib/chat/album-jobs";
import { mediaStore } from "@/lib/chat/media-store";

const POLL_MS = 5000;
const WRITERS = 3;
const COVER_WAIT_MS = 10 * 60 * 1000;
// A track the store has never heard of after this many looks is lost (a
// restart with no media store).
const LOST_AFTER = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Songs of one album rendering at once (ALBUM_TRACK_CONCURRENCY, 1-12,
 * default 3): enough to use several music workers, few enough that one
 * album does not fill the gateway's whole queue.
 */
export function trackConcurrency(env = process.env) {
  const n = Number(env.ALBUM_TRACK_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 3;
}

/** Run `fn(item, index)` over `items`, at most `n` at a time. */
export async function pool(items, n, fn) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(lanes);
}

/** Draw the album cover on a c0mpute image worker. Resolves true/false; never throws. */
export async function makeAlbumCover(id, plan, { resume = false } = {}) {
  const body = { prompt: albumCoverPrompt(plan), model: IMAGE_MODEL, ...IMAGE_SIZES.square, steps: 8 };
  try {
    const response = await runGatewayJob("/v1/images", body, { requestId: `${id}-cover`, resume });
    if (response?.status === 200 && response.body?.length > 8) {
      albumJobs.setCover(id, new Uint8Array(response.body));
      return true;
    }
  } catch (error) {
    console.warn(`[chat/album] cover failed: ${error?.message ?? error}`);
  }
  return false;
}

/**
 * Where one track's song job stands: { status: "pending" | "done" | "failed",
 * audio?, contentType?, error?, meta? }. `held` keeps the job objects this
 * process has seen, so a song the page already fetched (take()) still counts.
 */
export async function trackState(id, { held = new Map(), misses = new Map(), jobs = musicJobs } = {}) {
  const job = jobs.get(id) ?? held.get(id) ?? null;
  if (job) {
    held.set(id, job);
    if (job.status === "done") return { status: "done", audio: job.audio ?? null, contentType: job.contentType ?? "audio/mpeg" };
    if (job.status === "failed") return { status: "failed", error: job.error ?? "Song failed" };
    return { status: "pending", meta: job.meta ?? {} };
  }
  const rec = await jobs.find(id);
  if (rec?.status === "done") return { status: "done", audio: null, contentType: rec.result?.contentType ?? "audio/mpeg" };
  if (rec?.status === "failed") return { status: "failed", error: rec.error ?? "Song failed" };
  if (rec) return { status: "pending", meta: rec.meta ?? {} };
  const n = (misses.get(id) ?? 0) + 1;
  misses.set(id, n);
  return n >= LOST_AFTER ? { status: "failed", error: "This track was lost in a restart" } : { status: "pending", meta: {} };
}

/**
 * The album job, built from what its record keeps (the request and who pays),
 * so POST /api/chat/album and a resume after a restart run the same thing.
 */
export function albumRunner(request, billing = {}, { concurrency = trackConcurrency(), pollMs = POLL_MS } = {}) {
  return async (job) => {
    const ck = (job.checkpoint ??= {});
    const resume = Boolean(job.resumed);
    const live = [];

    if (!ck.plan) {
      job.meta = { stage: "planning", tracksWanted: request.tracks };
      ck.plan = await writeAlbumPlan(request);
      await job.checkpointed?.();
    }
    const plan = ck.plan;
    ck.specs ??= [];
    ck.trackIds ??= [];
    ck.trackStatus ??= [];
    ck.trackErrors ??= [];

    const publish = (stage) => {
      job.meta = {
        stage,
        band: plan.band,
        album: plan.album,
        genre: plan.genre,
        sound: plan.sound,
        concept: plan.concept,
        cover: ck.cover ?? "pending",
        tracks: plan.tracks.map((t, i) => ({
          n: t.n,
          title: t.title,
          theme: t.theme,
          vocals: t.vocals,
          duration: ck.specs[i]?.duration ?? t.duration,
          caption: ck.specs[i]?.caption ?? null,
          lyrics: ck.specs[i]?.lyrics ?? null,
          id: ck.trackIds[i] ?? null,
          status: ck.trackStatus[i] ?? (ck.specs[i] ? "written" : "planned"),
          error: ck.trackErrors[i] ?? undefined,
          node: live[i] ?? undefined
        })),
        done: ck.trackStatus.filter((s) => s === "done").length,
        failed: ck.trackStatus.filter((s) => s === "failed").length
      };
    };
    publish("writing");

    // Cover art in parallel on the image workers; it never fails the album.
    let coverDone = Promise.resolve();
    if (!ck.cover) {
      coverDone = makeAlbumCover(job.id, plan, { resume }).then((ok) => {
        ck.cover = ok ? "ready" : "failed";
        if (job.meta) job.meta = { ...job.meta, cover: ck.cover };
        return job.checkpointed?.();
      });
    }

    // Lyrics for every track first, so the whole record is on the page in a
    // minute or two and a resumed album sings the same words.
    await pool(plan.tracks, WRITERS, async (t, i) => {
      if (ck.specs[i]) return;
      ck.specs[i] = await writeTrack(plan, t, request.prompt);
      publish("writing");
      await job.checkpointed?.();
    });

    publish("recording");
    const held = new Map();
    const misses = new Map();
    const keepAudio = !mediaStore();
    const audio = [];
    await pool(plan.tracks, concurrency, async (t, i) => {
      if (ck.trackStatus[i] === "done" || ck.trackStatus[i] === "failed") return;
      if (!ck.trackIds[i]) {
        const spec = ck.specs[i];
        const song = { prompt: spec.caption, lyrics: spec.lyrics, duration: spec.duration, title: t.title, cover: false };
        ck.trackIds[i] = startMusicJob(musicRunner(song, billing), { request: song, billing });
        ck.trackStatus[i] = "pending";
        publish("recording");
        await job.checkpointed?.();
      }
      for (;;) {
        const state = await trackState(ck.trackIds[i], { held, misses });
        if (state.status === "pending") {
          live[i] = state.meta?.node ?? (state.meta?.stage ? { stage: state.meta.stage === "writing" ? "starting" : "finding_worker" } : undefined);
          publish("recording");
          await sleep(pollMs);
          continue;
        }
        live[i] = undefined;
        ck.trackStatus[i] = state.status;
        if (state.status === "failed") ck.trackErrors[i] = String(state.error ?? "Song failed").slice(0, 300);
        else if (keepAudio && state.audio) audio[i] = { bytes: state.audio, contentType: state.contentType };
        publish("recording");
        await job.checkpointed?.();
        return;
      }
    });

    const done = ck.trackStatus.filter((s) => s === "done").length;
    if (!done) throw Object.assign(new Error(ck.trackErrors.find(Boolean) || "No track of the album could be rendered"), { status: 502 });

    // The songs usually take longer than the cover; give a slow cover a while.
    if (!ck.cover) {
      publish("cover");
      await Promise.race([coverDone, sleep(COVER_WAIT_MS)]);
    }
    publish("done");
    return { trackAudio: keepAudio ? audio : null };
  };
}

/** Carry on with every album a restarted (or dead) process left pending. */
export function resumeAlbums() {
  return albumJobs.resumeAll((rec) => albumRunner(rec.request ?? {}, rec.billing ?? {}));
}
