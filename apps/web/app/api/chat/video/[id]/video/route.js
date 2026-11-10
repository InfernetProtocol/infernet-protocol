import { errorJson } from "@/lib/chat/speech-service";
import { getImageJob } from "@/lib/chat/image-jobs";
import { parseRange } from "@/lib/billing/video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/chat/video/<id>/video: the finished MP4, with Range (206) support. */
export async function GET(request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown video job", 404);
  const job = getImageJob(id);
  if (!job) return errorJson("This video job expired or the server restarted — try again", 404);
  if (job.status === "pending") return errorJson("The video is not ready yet", 409);
  if (job.status === "failed") return errorJson(job.error, job.httpStatus || 502);
  const bytes = job.png;
  const size = bytes.byteLength;
  const base = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, no-store", ...job.headers };
  const range = parseRange(request.headers.get("range"), size);
  if (range === false) {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  }
  if (range) {
    return new Response(bytes.subarray(range.start, range.end + 1), {
      status: 206,
      headers: { ...base, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) }
    });
  }
  return new Response(bytes, { status: 200, headers: { ...base, "content-length": String(size) } });
}
