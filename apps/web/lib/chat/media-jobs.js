// In-process registries for slow /chat media jobs (music; images keep their
// own module, image-jobs.js, with the same shape).
//
// A job takes minutes on a c0mpute worker and nginx cuts a request at 300 s,
// so the POST route starts the job and returns an id, and the page polls
// GET .../<id>. Results live in this process only, for `ttlMs`: a deploy
// mid-job loses it and the page reports that.

import { randomUUID } from "node:crypto";

/**
 * `run()` must resolve to an object (its fields are copied onto the job, e.g.
 * { audio, contentType, headers }) or throw an Error with `.status`.
 */
export function createJobRegistry({ ttlMs = 15 * 60 * 1000, maxJobs = 200 } = {}) {
  const jobs = new Map();

  function sweep(now = Date.now()) {
    for (const [id, job] of jobs) {
      if (now - job.createdAt > ttlMs) jobs.delete(id);
    }
    while (jobs.size > maxJobs) jobs.delete(jobs.keys().next().value);
  }

  function start(run, { now = Date.now() } = {}) {
    sweep(now);
    const id = randomUUID();
    const job = { id, createdAt: now, status: "pending", headers: {}, error: null, httpStatus: 0 };
    jobs.set(id, job);
    Promise.resolve()
      .then(run)
      .then((result) => {
        const { headers, ...rest } = result ?? {};
        Object.assign(job, rest);
        job.headers = headers ?? {};
        job.status = "done";
      })
      .catch((err) => {
        job.status = "failed";
        job.error = err?.message ?? String(err);
        job.httpStatus = Number(err?.status) || 502;
      });
    return id;
  }

  function get(id, { now = Date.now() } = {}) {
    sweep(now);
    return jobs.get(id) ?? null;
  }

  /** Hand the result out once, then forget it. */
  function take(id) {
    const job = jobs.get(id);
    if (job?.status === "done") jobs.delete(id);
    return job ?? null;
  }

  return { start, get, take };
}
