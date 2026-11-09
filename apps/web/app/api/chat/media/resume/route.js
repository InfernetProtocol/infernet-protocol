import { resumeMediaJobs } from "@/lib/chat/media-resume";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/chat/media/resume: pick up promo videos and songs that a
 * restart left pending (instrumentation.js calls it on boot and every
 * minute). Idempotent and debounced to one scan per 30 s, so it is safe to
 * leave open: it only ever carries on with jobs that were already paid for.
 */
export async function POST() {
  const { promos, songs } = await resumeMediaJobs();
  return Response.json({ resumed: { promos: promos.length, songs: songs.length } }, { headers: { "cache-control": "no-store" } });
}
