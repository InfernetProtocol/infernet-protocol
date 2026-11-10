import "server-only";

// Resume the promo videos, songs and albums a restarted (or dead) process
// left pending, at most once per RESUME_EVERY_MS however often it is asked.
// instrumentation.js asks on boot and every minute after.

import { resumePromos } from "@/lib/promo/run";
import { resumeSongs } from "@/lib/chat/music-run";
import { resumeAlbums } from "@/lib/chat/album-run";

const RESUME_EVERY_MS = 30_000;

const attempt = (what, fn) =>
  fn().catch((e) => {
    console.warn(`[media] resuming ${what} failed: ${e?.message ?? e}`);
    return [];
  });

export async function resumeMediaJobs({ now = Date.now() } = {}) {
  const g = globalThis;
  if (g.__infernetMediaResume && now - g.__infernetMediaResume.at < RESUME_EVERY_MS) return g.__infernetMediaResume.result;
  const result = (async () => {
    // Songs first: an album resumed in the same pass then finds its tracks
    // already running in this process.
    const [promos, songs] = await Promise.all([attempt("promos", resumePromos), attempt("songs", resumeSongs)]);
    const albums = await attempt("albums", resumeAlbums);
    return { promos, songs, albums };
  })();
  g.__infernetMediaResume = { at: now, result };
  return result;
}
