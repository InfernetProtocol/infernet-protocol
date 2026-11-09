import { readFile } from "node:fs/promises";
import path from "node:path";
import { errorJson } from "@/lib/chat/speech-service";
import { isPromoId, promoJobs } from "@/lib/promo/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/chat/promo/<id>/frame/<n>: storyboard keyframe n (0-based, PNG) once drawn. */
export async function GET(_request, { params }) {
  const { id, n } = await params;
  const i = Number(n);
  if (!isPromoId(id) || !Number.isInteger(i) || i < 0 || i > 15) return errorJson("Unknown frame", 404);
  const job = promoJobs.get(id);
  if (!job) return errorJson("This promo expired", 404);
  try {
    const png = await readFile(path.join(job.dir, `frame-${i}.png`));
    return new Response(png, { status: 200, headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  } catch {
    return errorJson("Not drawn yet", 404);
  }
}
