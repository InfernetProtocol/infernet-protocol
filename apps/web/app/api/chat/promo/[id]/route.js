import { errorJson } from "@/lib/chat/speech-service";
import { isPromoId, promoJobs, publicJob } from "@/lib/promo/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/chat/promo/<id>: 202 with per-stage progress while it works,
 * 200 with { video, captions, duration } when done, or the error.
 */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!isPromoId(id)) return errorJson("Unknown promo job", 404);
  const job = await promoJobs.find(id);
  if (!job) return errorJson("This promo expired; make a new one", 404);
  const body = publicJob(job);
  if (job.status === "failed") return Response.json(body, { status: job.httpStatus || 502, headers: { "cache-control": "no-store" } });
  return Response.json(body, { status: job.status === "done" ? 200 : 202, headers: { "cache-control": "no-store" } });
}
