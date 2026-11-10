// /chat promo jobs. A promo takes 5-15 minutes, so POST /api/chat/promo starts
// one and the page polls GET /api/chat/promo/<id> for per-stage progress,
// storyboard frames as they land, then the MP4.
//
// Work happens in a local directory (job.dir). With a media store configured
// (media-store.js: Supabase Storage in production), the record, each stage's
// checkpoint and every artifact (frames, clips, narration, soundtrack, the
// MP4 and SRT) are also saved there as they land, so a deploy that restarts
// this process mid-promo loses nothing: the next process resumes the job
// from its last completed stage (resumeAll), and finished promos stay
// downloadable for MEDIA_JOB_TTL_DAYS (7) from any process.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDurableJobs, keepJobAlive, ttlFromEnv } from "@/lib/chat/durable-jobs";
import { mediaStore } from "@/lib/chat/media-store";

// How long a job stays in this process's memory; the store keeps it longer.
export const PROMO_JOB_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_JOBS = 40;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many promos one process renders at once (PROMO_MAX_RUNNING, default 3). */
export function promoMaxRunning(env = process.env) {
  const n = Number(env.PROMO_MAX_RUNNING);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

export function promoRoot(env = process.env) {
  return env.PROMO_WORK_DIR || path.join(os.tmpdir(), "infernet-promo");
}

const CONTENT_TYPES = { ".png": "image/png", ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".srt": "application/x-subrip", ".svg": "image/svg+xml" };
const typeOf = (name) => CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";

/**
 * `durable` is a createDurableJobs({ kind: "promo" }) instance (or null for
 * memory only). `run(job)` does the work in `job.dir`, publishes progress on
 * `job.meta`, records stage results on `job.checkpoint` and resolves to the
 * result ({ video, srt, duration, bytes, ... }).
 */
export function createPromoRegistry({ ttlMs = PROMO_JOB_TTL_MS, maxJobs = MAX_JOBS, root = promoRoot(), durable = null } = {}) {
  const jobs = new Map();
  const store = () => (typeof durable === "function" ? durable() : durable);
  let lastSweep = 0;

  function drop(id) {
    const job = jobs.get(id);
    jobs.delete(id);
    if (job?.dir) rmSync(job.dir, { recursive: true, force: true });
  }

  function sweep(now = Date.now()) {
    for (const [id, job] of jobs) if (job.status !== "pending" && now - job.createdAt > ttlMs) drop(id);
    // Over the cap: drop the oldest finished jobs first, never a running one.
    for (const [id, job] of jobs) {
      if (jobs.size <= maxJobs) break;
      if (job.status !== "pending") drop(id);
    }
  }

  /** Running jobs right now (the route caps concurrent renders). */
  function running() {
    let n = 0;
    for (const job of jobs.values()) if (job.status === "pending" && !job.remote) n++;
    return n;
  }

  function record(job) {
    const { video, srt, ...rest } = job.result ?? {};
    return {
      id: job.id,
      createdAt: job.createdAt,
      status: job.status,
      request: job.request ?? null,
      billing: job.billing ?? null,
      meta: job.meta,
      checkpoint: job.checkpoint,
      result: job.result ? { ...rest, video: video ? "promo.mp4" : null, srt: srt ? "promo.srt" : null } : null,
      error: job.error,
      httpStatus: job.httpStatus,
      finishedAt: job.finishedAt
    };
  }

  function launch(job, run) {
    const d = store();
    const alive = d?.enabled ? keepJobAlive(d, job.id, () => record(job), { onLost: () => { job.lost = true; } }) : null;
    // The pipeline calls these as it goes; both are no-ops without a store.
    job.saveArtifact = async (name, bytes) => {
      if (!alive || job.lost) return;
      try {
        await d.putFile(job.id, name, bytes, typeOf(name));
      } catch (e) {
        console.warn(`[promo] job ${job.id}: keeping ${name} failed: ${e?.message ?? e}`);
      }
    };
    job.checkpointed = () => alive?.flush();
    const progress = setInterval(() => alive?.touch(), 5000);
    progress.unref?.();
    Promise.resolve()
      .then(async () => {
        // Hold the lease before the record says pending, so no other process
        // mistakes a brand-new job for an orphan.
        if (alive) {
          await d.renew(job.id).catch((e) => console.warn(`[promo] lease ${job.id}: ${e?.message ?? e}`));
          await alive.flush();
        }
      })
      .then(() => run(job))
      .then(async (result) => {
        if (alive && result?.video) await job.saveArtifact("promo.mp4", await readFile(result.video));
        if (alive && result?.srt) await job.saveArtifact("promo.srt", await readFile(result.srt));
        job.result = result ?? null;
        job.status = "done";
        job.finishedAt = Date.now();
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err?.message ?? String(err);
        job.httpStatus = Number(err?.status) || 502;
        job.finishedAt = Date.now();
        console.warn(`[promo] job ${job.id} failed: ${job.error}`);
      })
      .finally(async () => {
        clearInterval(progress);
        if (alive) {
          await alive.flush();
          await alive.stop();
        }
      });
  }

  function newJob({ id, now, owner, request, billing, checkpoint = {}, meta = {}, createdAt = now }) {
    const dir = path.join(root, id);
    mkdirSync(dir, { recursive: true });
    return { id, dir, owner, request, billing, createdAt, status: "pending", meta, checkpoint, result: null, error: null, httpStatus: 0, finishedAt: null };
  }

  function start(run, { now = Date.now(), owner = null, request = null, billing = null } = {}) {
    sweep(now);
    const job = newJob({ id: randomUUID(), now, owner, request, billing });
    jobs.set(job.id, job);
    launch(job, run);
    return job.id;
  }

  function get(id, { now = Date.now() } = {}) {
    sweep(now);
    return jobs.get(id) ?? null;
  }

  /**
   * This process's job, else the store's record of it (another process ran
   * or is running it). Finished records are cached here.
   */
  async function find(id, { now = Date.now() } = {}) {
    const mine = get(id, { now });
    if (mine && !(mine.remote && mine.status === "pending")) return mine;
    const d = store();
    if (!d?.enabled) return mine;
    const rec = await d.load(id).catch((e) => {
      console.warn(`[promo] load ${id}: ${e?.message ?? e}`);
      return null;
    });
    if (!rec) return mine;
    const job = {
      id,
      remote: true,
      dir: path.join(root, id),
      createdAt: rec.createdAt,
      status: rec.status,
      meta: rec.meta ?? {},
      checkpoint: rec.checkpoint ?? {},
      result: rec.result ?? null,
      error: rec.error ?? null,
      httpStatus: rec.httpStatus ?? 0,
      finishedAt: rec.finishedAt ?? null
    };
    jobs.set(id, job);
    return job;
  }

  /** A local path to the job's file `name`, fetched from the store if needed; null if it has none. */
  async function file(job, name) {
    if (!job || !FILE_NAME.test(String(name))) return null;
    const local = path.join(job.dir, name);
    if (existsSync(local)) return local;
    const d = store();
    if (!d?.enabled) return null;
    const bytes = await d.getFile(job.id, name).catch(() => null);
    if (!bytes) return null;
    mkdirSync(job.dir, { recursive: true });
    await writeFile(local, bytes);
    return local;
  }

  /**
   * Work dirs under `root` that no job here owns and that have not changed for
   * ttlMs: left by a process that died (a container restart keeps its tmp).
   * A live or resumed job's dir is in `jobs`, so it is never touched.
   */
  function sweepLocal(now = Date.now()) {
    let names = [];
    try {
      names = readdirSync(root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (jobs.has(name) || !UUID.test(name)) continue;
      const dir = path.join(root, name);
      try {
        if (now - statSync(dir).mtimeMs <= ttlMs) continue;
        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {}
    }
    return removed;
  }

  /**
   * Claim every pending job no live process is running and carry on with it
   * from its checkpoint. `runnerFor(record)` returns the `run(job)` to use.
   * Claims no more than fit under `maxRunning` (counting what already runs
   * here); the rest stay pending for a later pass. Expires old jobs (in the
   * store and stray local work dirs) at most once an hour. Resolves to the
   * ids resumed.
   */
  async function resumeAll(runnerFor, { now = Date.now(), maxRunning = Infinity } = {}) {
    const d = store();
    if (now - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = now;
      sweepLocal(now);
      if (d?.enabled) await d.sweep().catch((e) => console.warn(`[promo] sweep: ${e?.message ?? e}`));
    }
    if (!d?.enabled) return [];
    const resumed = [];
    for (const id of await d.pending()) {
      if (running() >= maxRunning) break;
      const mine = jobs.get(id);
      if (mine && !mine.remote) continue;
      if (!(await d.claim(id).catch(() => false))) continue;
      const rec = await d.load(id);
      if (rec?.status !== "pending") {
        await d.release(id);
        continue;
      }
      const job = newJob({ id, now, request: rec.request, billing: rec.billing, checkpoint: rec.checkpoint ?? {}, meta: rec.meta ?? {}, createdAt: rec.createdAt });
      job.resumed = true;
      for (const name of await d.files(id)) {
        if (name === "promo.mp4" || name === "promo.srt" || !FILE_NAME.test(name)) continue;
        const bytes = await d.getFile(id, name).catch(() => null);
        if (bytes) await writeFile(path.join(job.dir, name), bytes);
      }
      jobs.set(id, job);
      console.log(`[promo] resuming job ${id} (done: ${Object.keys(job.checkpoint).join(", ") || "nothing"})`);
      launch(job, runnerFor(rec));
      resumed.push(id);
    }
    return resumed;
  }

  return { start, get, find, file, running, drop, resumeAll, sweepLocal };
}

// One registry per server process (globalThis survives Next's module reloads in dev).
const g = globalThis;
g.__infernetPromoDurable ??= createDurableJobs({ kind: "promo", store: () => mediaStore(), ttlMs: ttlFromEnv() });
g.__infernetPromoJobs ??= createPromoRegistry({ durable: g.__infernetPromoDurable });
export const promoJobs = g.__infernetPromoJobs;

export const isPromoId = (id) => UUID.test(String(id ?? ""));

/** What a poll shows: never the dir or other server paths. */
export function publicJob(job, { now = Date.now() } = {}) {
  const base = `/api/chat/promo/${job.id}`;
  const out = {
    id: job.id,
    status: job.status,
    seconds: Math.round(((job.finishedAt ?? now) - job.createdAt) / 1000),
    ...job.meta
  };
  if (job.status === "done" && job.result) {
    out.video = `${base}/video`;
    out.captions = `${base}/captions`;
    out.duration = Math.round(job.result.duration * 10) / 10;
    out.bytes = job.result.bytes;
  }
  if (job.status === "failed") out.error = job.error;
  return out;
}

/** Parse one `bytes=a-b` range against `size`, or null for the whole file. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === "" ? size - 1 : m[2] === "" ? size - 1 : Number(m[2]);
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end) return { invalid: true };
  return { start, end };
}
