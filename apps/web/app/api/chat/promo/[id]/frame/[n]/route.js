import { readFile } from "node:fs/promises";
import { errorJson } from "@/lib/chat/speech-service";
import { isPromoId, promoJobs } from "@/lib/promo/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/chat/promo/<id>/frame/<n>: storyboard keyframe n (0-based, PNG) once drawn. */
export async function GET(_request, { params }) {
  const { id, n } = await params;
  const i = Number(n);
  if (!isPromoId(id) || !Number.isInteger(i) || i < 0 || i > 15) return errorJson("Unknown frame", 404);
  const job = await promoJobs.find(id);
  if (!job) return errorJson("This promo expired", 404);
  try {
    const file = await promoJobs.file(job, `frame-${i}.png`);
    if (!file) throw new Error("not drawn");
    const png = await readFile(file);
    return new Response(png, { status: 200, headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
  } catch {
    return errorJson("Not drawn yet", 404);
  }
}
