// /chat promo jobs. A promo takes 5-15 minutes, so POST /api/chat/promo starts
// one and the page polls GET /api/chat/promo/<id> for per-stage progress,
// storyboard frames as they land, then the MP4. Unlike songs, the result is
// kept (on disk, in the job's own directory) until the job expires, so the
// player, the download button and the CLI can all fetch it.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROMO_JOB_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_JOBS = 40;

export function promoRoot(env = process.env) {
  return env.PROMO_WORK_DIR || path.join(os.tmpdir(), "infernet-promo");
}

export function createPromoRegistry({ ttlMs = PROMO_JOB_TTL_MS, maxJobs = MAX_JOBS, root = promoRoot() } = {}) {
  const jobs = new Map();

  function drop(id) {
    const job = jobs.get(id);
    jobs.delete(id);
    if (job?.dir) rmSync(job.dir, { recursive: true, force: true });
  }

  function sweep(now = Date.now()) {
    for (const [id, job] of jobs) if (now - job.createdAt > ttlMs) drop(id);
    // Over the cap: drop the oldest finished jobs first, never a running one.
    for (const [id, job] of jobs) {
      if (jobs.size <= maxJobs) break;
      if (job.status !== "pending") drop(id);
    }
  }

  /** Running jobs right now (the route caps concurrent renders). */
  function running() {
    let n = 0;
    for (const job of jobs.values()) if (job.status === "pending") n++;
    return n;
  }

  /**
   * `run(job)` does the work in `job.dir`, publishes progress on `job.meta`
   * and resolves to the result ({ video, srt, duration, bytes, ... }).
   */
  function start(run, { now = Date.now(), owner = null } = {}) {
    sweep(now);
    const id = randomUUID();
    const dir = path.join(root, id);
    mkdirSync(dir, { recursive: true });
    const job = { id, dir, owner, createdAt: now, status: "pending", meta: {}, result: null, error: null, httpStatus: 0, finishedAt: null };
    jobs.set(id, job);
    Promise.resolve()
      .then(() => run(job))
      .then((result) => {
        job.result = result ?? null;
        job.status = "done";
        job.finishedAt = Date.now();
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err?.message ?? String(err);
        job.httpStatus = Number(err?.status) || 502;
        job.finishedAt = Date.now();
        console.warn(`[promo] job ${id} failed: ${job.error}`);
      });
    return id;
  }

  function get(id, { now = Date.now() } = {}) {
    sweep(now);
    return jobs.get(id) ?? null;
  }

  return { start, get, running, drop };
}

// One registry per server process (globalThis survives Next's module reloads in dev).
const g = globalThis;
g.__infernetPromoJobs ??= createPromoRegistry();
export const promoJobs = g.__infernetPromoJobs;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
