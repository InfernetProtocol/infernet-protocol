// /chat music jobs: ACE-Step 1.5 on a c0mpute worker takes minutes, so
// POST /api/chat/music returns an id and the page polls
// GET /api/chat/music/<id>. See media-jobs.js.

import { createJobRegistry } from "@/lib/chat/media-jobs";

// Writing (~1 min) + queue (up to 8) + a 2-3 minute song on CPU (up to ~15).
export const MUSIC_JOB_TTL_MS = 45 * 60 * 1000;
const registry = createJobRegistry({ ttlMs: MUSIC_JOB_TTL_MS, maxJobs: 100 });

// Cover art, kept apart from the song job: the audio is handed out once and
// forgotten, but the page may fetch the cover before or after it.
const covers = new Map();

export function setMusicCover(id, png, { now = Date.now() } = {}) {
  for (const [k, c] of covers) if (now - c.at > MUSIC_JOB_TTL_MS) covers.delete(k);
  while (covers.size >= 100) covers.delete(covers.keys().next().value);
  covers.set(id, { png, at: now });
}

export function getMusicCover(id, { now = Date.now() } = {}) {
  const c = covers.get(id);
  if (!c) return null;
  if (now - c.at > MUSIC_JOB_TTL_MS) {
    covers.delete(id);
    return null;
  }
  return c.png;
}

/** `run()` resolves to { audio: Uint8Array, contentType, headers } or throws with `.status`. */
export const startMusicJob = (run, opts) => registry.start(run, opts);
export const getMusicJob = (id, opts) => registry.get(id, opts);
export const takeMusicJob = (id) => registry.take(id);
