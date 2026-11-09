import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { errorJson } from "@/lib/chat/speech-service";
import { isPromoId, parseRange, promoJobs } from "@/lib/promo/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/chat/promo/<id>/video: the finished MP4, with byte ranges so the
 * player can seek. `?download=1` asks the browser to save it.
 */
export async function GET(request, { params }) {
  const { id } = await params;
  if (!isPromoId(id)) return errorJson("Unknown promo job", 404);
  const job = await promoJobs.find(id);
  if (!job) return errorJson("This promo expired", 404);
  if (job.status !== "done" || !job.result?.video) return errorJson("The promo is not finished yet", 409);
  const file = await promoJobs.file(job, "promo.mp4");
  const size = file ? (await stat(file).catch(() => null))?.size : 0;
  if (!size) return errorJson("The promo file is gone", 410);
  const download = new URL(request.url).searchParams.get("download") === "1";
  const headers = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    ...(download ? { "content-disposition": 'attachment; filename="promo.mp4"' } : {})
  };
  const range = parseRange(request.headers.get("range"), size);
  if (range?.invalid) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  if (range) {
    const stream = Readable.toWeb(createReadStream(file, { start: range.start, end: range.end }));
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) }
    });
  }
  return new Response(Readable.toWeb(createReadStream(file)), { status: 200, headers: { ...headers, "content-length": String(size) } });
}
