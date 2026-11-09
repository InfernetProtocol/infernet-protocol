// /chat music jobs: ACE-Step 1.5 on a c0mpute worker takes minutes, so
// POST /api/chat/music returns an id and the page polls
// GET /api/chat/music/<id>. See media-jobs.js.
//
// With a media store (media-store.js) each job's record (request, who pays,
// the written spec, progress), the song and its cover art are also kept
// there: a deploy mid-song resumes the job in the next process
// (resumeAll) and a finished song stays downloadable for
// MEDIA_JOB_TTL_DAYS (7) from any process.

import { createJobRegistry } from "@/lib/chat/media-jobs";
import { createDurableJobs, keepJobAlive, ttlFromEnv } from "@/lib/chat/durable-jobs";
import { mediaStore } from "@/lib/chat/media-store";

// Writing (~1 min) + queue (up to 8) + a 2-3 minute song on CPU (up to ~15).
export const MUSIC_JOB_TTL_MS = 45 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const EXT = { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/flac": "flac", "audio/ogg": "ogg" };

export function createMusicJobs({ durable = null, ttlMs = MUSIC_JOB_TTL_MS, maxJobs = 100 } = {}) {
  const registry = createJobRegistry({ ttlMs, maxJobs });
  const store = () => (typeof durable === "function" ? durable() : durable);
  let lastSweep = 0;

  // Cover art, kept apart from the song job: the audio is handed out once and
  // forgotten, but the page may fetch the cover before or after it.
  const covers = new Map();

  function setCover(id, png, { now = Date.now() } = {}) {
    for (const [k, c] of covers) if (now - c.at > ttlMs) covers.delete(k);
    while (covers.size >= 100) covers.delete(covers.keys().next().value);
    covers.set(id, { png, at: now });
    const d = store();
    if (d?.enabled) {
      d.putFile(id, "cover.png", Buffer.from(png), "image/png").catch((e) => console.warn(`[music] keep cover ${id}: ${e?.message ?? e}`));
    }
  }

  function getCover(id, { now = Date.now() } = {}) {
    const c = covers.get(id);
    if (!c) return null;
    if (now - c.at > ttlMs) {
      covers.delete(id);
      return null;
    }
    return c.png;
  }

  function record(job) {
    return {
      id: job.id,
      createdAt: job.createdAt,
      status: job.final?.status ?? "pending",
      request: job.request ?? null,
      billing: job.billing ?? null,
      meta: job.meta ?? {},
      checkpoint: job.checkpoint ?? {},
      result: job.final?.result ?? null,
      error: job.final?.error ?? null,
      httpStatus: job.final?.httpStatus ?? 0,
      finishedAt: job.final?.finishedAt ?? null
    };
  }

  /** Wrap `run` so the job is recorded, checkpointed and its song kept. */
  function durableRun(run, { request = null, billing = null, checkpoint = {}, meta = undefined, resumed = false } = {}) {
    return async (job) => {
      job.request = request;
      job.billing = billing;
      job.checkpoint = checkpoint;
      if (meta) job.meta = meta;
      job.resumed = resumed;
      const d = store();
      const alive = d?.enabled ? keepJobAlive(d, job.id, () => record(job)) : null;
      job.checkpointed = () => alive?.flush();
      const progress = alive ? setInterval(() => alive.touch(), 5000) : null;
      progress?.unref?.();
      try {
        if (alive) {
          await d.renew(job.id).catch(() => {});
          await alive.flush();
        }
        const result = await run(job);
        let file = null;
        if (alive && result?.audio) {
          file = `song.${EXT[result.contentType] ?? "mp3"}`;
          await d.putFile(job.id, file, Buffer.from(result.audio), result.contentType).catch((e) => {
            file = null;
            console.warn(`[music] keep song ${job.id}: ${e?.message ?? e}`);
          });
        }
        job.final = { status: "done", finishedAt: Date.now(), result: file ? { file, contentType: result.contentType, headers: result.headers ?? {} } : null };
        return result;
      } catch (err) {
        job.final = { status: "failed", finishedAt: Date.now(), error: err?.message ?? String(err), httpStatus: Number(err?.status) || 502 };
        throw err;
      } finally {
        if (progress) clearInterval(progress);
        if (alive) {
          await alive.flush();
          await alive.stop();
        }
      }
    };
  }

  /** `run(job)` resolves to { audio: Uint8Array, contentType, headers } or throws with `.status`. */
  function start(run, { now = Date.now(), request = null, billing = null } = {}) {
    return registry.start(durableRun(run, { request, billing }), { now });
  }

  /** The store's record of a job this process does not have (a restart). */
  async function find(id) {
    const d = store();
    if (!d?.enabled) return null;
    return d.load(id).catch(() => null);
  }

  /** A finished job's song bytes from the store, or null. */
  async function song(rec) {
    const d = store();
    if (!d?.enabled || !rec?.result?.file) return null;
    return d.getFile(rec.id, rec.result.file).catch(() => null);
  }

  async function storedCover(id) {
    const d = store();
    if (!d?.enabled) return null;
    return d.getFile(id, "cover.png").catch(() => null);
  }

  /**
   * Resume every pending song no live process holds. `runnerFor(record)`
   * returns the `run(job)` to use. Resolves to the ids resumed.
   */
  async function resumeAll(runnerFor, { now = Date.now() } = {}) {
    const d = store();
    if (!d?.enabled) return [];
    if (now - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = now;
      await d.sweep().catch((e) => console.warn(`[music] sweep: ${e?.message ?? e}`));
    }
    const resumed = [];
    for (const id of await d.pending()) {
      if (registry.get(id)) continue;
      if (!(await d.claim(id).catch(() => false))) continue;
      const rec = await d.load(id);
      if (rec?.status !== "pending") {
        await d.release(id);
        continue;
      }
      console.log(`[music] resuming job ${id}`);
      registry.start(durableRun(runnerFor(rec), { request: rec.request, billing: rec.billing, checkpoint: rec.checkpoint ?? {}, meta: rec.meta, resumed: true }), {
        now,
        id,
        createdAt: rec.createdAt ?? now
      });
      resumed.push(id);
    }
    return resumed;
  }

  return {
    start,
    get: (id, opts) => registry.get(id, opts),
    take: (id) => registry.take(id),
    find,
    song,
    storedCover,
    setCover,
    getCover,
    resumeAll
  };
}

const g = globalThis;
g.__infernetMusicJobs ??= createMusicJobs({ durable: createDurableJobs({ kind: "music", store: () => mediaStore(), ttlMs: ttlFromEnv() }) });
export const musicJobs = g.__infernetMusicJobs;

export const setMusicCover = (id, png, opts) => musicJobs.setCover(id, png, opts);
export const getMusicCover = (id, opts) => musicJobs.getCover(id, opts);
export const startMusicJob = (run, opts) => musicJobs.start(run, opts);
export const getMusicJob = (id, opts) => musicJobs.get(id, opts);
export const takeMusicJob = (id) => musicJobs.take(id);
