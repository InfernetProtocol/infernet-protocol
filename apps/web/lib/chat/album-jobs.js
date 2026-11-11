// /chat album jobs. An album is a plan (band, title, tracks), a cover and one
// song job per track (music-jobs.js); this registry keeps the album's own
// record. It is the same durable registry songs use, under kind "album", so
// a deploy mid-album resumes it (album-run.js resumeAlbums) and a finished
// album stays downloadable for MEDIA_JOB_TTL_DAYS (7) from any process.

import { createMusicJobs } from "@/lib/chat/music-jobs";
import { createDurableJobs, ttlFromEnv } from "@/lib/chat/durable-jobs";
import { mediaStore } from "@/lib/chat/media-store";

// Planning, lyrics and 8-12 songs a few at a time on whatever music workers
// are up: hours on a quiet network. The store marks a job failed once it is
// pending past its stuck limit, so keep it in memory as long as that. Songs
// run up to 10 minutes now (2 h each on a CPU node), so twelve of them three
// at a time can take most of a day: the 6 h STUCK_MS songs use is too short.
export const ALBUM_STUCK_MS = 24 * 60 * 60 * 1000;
export const ALBUM_JOB_TTL_MS = ALBUM_STUCK_MS;

const g = globalThis;
g.__infernetAlbumJobs ??= createMusicJobs({
  ttlMs: ALBUM_JOB_TTL_MS,
  maxJobs: 40,
  durable: createDurableJobs({ kind: "album", store: () => mediaStore(), ttlMs: ttlFromEnv(), stuckMs: ALBUM_STUCK_MS })
});
export const albumJobs = g.__infernetAlbumJobs;
