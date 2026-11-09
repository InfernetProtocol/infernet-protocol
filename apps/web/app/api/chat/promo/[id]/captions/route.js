import { readFile } from "node:fs/promises";
import { errorJson } from "@/lib/chat/speech-service";
import { isPromoId, promoJobs } from "@/lib/promo/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/chat/promo/<id>/captions: the narration as SubRip (.srt). */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!isPromoId(id)) return errorJson("Unknown promo job", 404);
  const job = await promoJobs.find(id);
  if (!job?.result?.srt) return errorJson("No captions (yet)", 404);
  const file = await promoJobs.file(job, "promo.srt");
  const srt = file ? await readFile(file).catch(() => null) : null;
  if (!srt) return errorJson("No captions", 404);
  return new Response(srt, {
    status: 200,
    headers: { "content-type": "application/x-subrip; charset=utf-8", "content-disposition": 'attachment; filename="promo.srt"', "cache-control": "private, max-age=3600" }
  });
}
