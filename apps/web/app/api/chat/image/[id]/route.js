import { errorJson } from "@/lib/chat/speech-service";
import { getImageJob, takeImageJob } from "@/lib/chat/image-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/chat/image/<id>: 202 while drawing, then the PNG once, or the error. */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown image job", 404);
  const job = getImageJob(id);
  if (!job) return errorJson("This image job expired or the server restarted — try again", 404);
  if (job.status === "pending") {
    return Response.json(
      { id, status: "pending", seconds: Math.round((Date.now() - job.createdAt) / 1000) },
      { status: 202, headers: { "cache-control": "no-store" } }
    );
  }
  if (job.status === "failed") return errorJson(job.error, job.httpStatus || 502);
  const done = takeImageJob(id);
  return new Response(done.png, {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "no-store", ...done.headers }
  });
}
