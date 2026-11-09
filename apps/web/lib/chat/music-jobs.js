// /chat music jobs: ACE-Step 1.5 on a c0mpute worker takes minutes, so
// POST /api/chat/music returns an id and the page polls
// GET /api/chat/music/<id>. See media-jobs.js.

import { createJobRegistry } from "@/lib/chat/media-jobs";

export const MUSIC_JOB_TTL_MS = 20 * 60 * 1000;
const registry = createJobRegistry({ ttlMs: MUSIC_JOB_TTL_MS, maxJobs: 100 });

/** `run()` resolves to { audio: Uint8Array, contentType, headers } or throws with `.status`. */
export const startMusicJob = (run, opts) => registry.start(run, opts);
export const getMusicJob = (id, opts) => registry.get(id, opts);
export const takeMusicJob = (id) => registry.take(id);
