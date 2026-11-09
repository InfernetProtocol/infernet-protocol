// In-process registry of /chat image jobs.
//
// An image takes 1-5 minutes on a c0mpute CPU worker and nginx cuts a request
// at 300 s, so POST /api/chat/image starts the job and returns an id, and the
// page polls GET /api/chat/image/<id>. Results live in this process only, for
// IMAGE_JOB_TTL_MS: a deploy mid-job loses it and the page reports that.

import { randomUUID } from "node:crypto";
import { GATEWAY_JOB_LIMIT_MS } from "@/lib/chat/speech-service";

// A job may wait in the gateway's queue for a worker (2 h by default) before
// it renders; it stays readable that long plus a margin to collect it.
export const IMAGE_JOB_TTL_MS = GATEWAY_JOB_LIMIT_MS + 30 * 60 * 1000;
const MAX_JOBS = 200;
const jobs = new Map();

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (now - job.createdAt > IMAGE_JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
}

/**
 * Start `run(job)` in the background. It must resolve to
 * { png: Uint8Array, headers: object } or throw an Error with `.status`.
 * `job.id` doubles as the gateway request id; `job.meta` carries the
 * gateway's live progress (queued, rendering) for the poll route.
 */
export function startImageJob(run, { now = Date.now() } = {}) {
  sweep(now);
  const id = randomUUID();
  const job = { id, createdAt: now, status: "pending", png: null, headers: {}, error: null, httpStatus: 0, meta: null };
  jobs.set(id, job);
  Promise.resolve()
    .then(() => run(job))
    .then(({ png, headers }) => {
      job.status = "done";
      job.png = png;
      job.headers = headers ?? {};
    })
    .catch((err) => {
      job.status = "failed";
      job.error = err?.message ?? String(err);
      job.httpStatus = Number(err?.status) || 502;
    });
  return id;
}

export function getImageJob(id, { now = Date.now() } = {}) {
  sweep(now);
  return jobs.get(id) ?? null;
}

/** Hand the bytes out once, then forget them. */
export function takeImageJob(id) {
  const job = jobs.get(id);
  if (job?.status === "done") jobs.delete(id);
  return job ?? null;
}
