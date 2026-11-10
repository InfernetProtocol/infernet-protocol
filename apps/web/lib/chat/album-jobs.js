// /chat album jobs. An album is a plan (band, title, tracks), a cover and one
// song job per track (music-jobs.js); this registry keeps the album's own
// record. It is the same durable registry songs use, under kind "album", so
// a deploy mid-album resumes it (album-run.js resumeAlbums) and a finished
// album stays downloadable for MEDIA_JOB_TTL_DAYS (7) from any process.

import { createMusicJobs } from "@/lib/chat/music-jobs";
import { createDurableJobs, ttlFromEnv, STUCK_MS } from "@/lib/chat/durable-jobs";
import { mediaStore } from "@/lib/chat/media-store";

// Planning, lyrics and 8-12 songs a few at a time on whatever music workers
// are up: hours on a quiet network. The store marks a job failed once it is
// pending past STUCK_MS, so keep it in memory as long as that.
export const ALBUM_JOB_TTL_MS = STUCK_MS;

const g = globalThis;
g.__infernetAlbumJobs ??= createMusicJobs({
  ttlMs: ALBUM_JOB_TTL_MS,
  maxJobs: 40,
  durable: createDurableJobs({ kind: "album", store: () => mediaStore(), ttlMs: ttlFromEnv() })
});
export const albumJobs = g.__infernetAlbumJobs;
