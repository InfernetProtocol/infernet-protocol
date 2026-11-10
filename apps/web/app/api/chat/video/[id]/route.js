import { errorJson } from "@/lib/chat/speech-service";
import { getImageJob } from "@/lib/chat/image-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/chat/video/<id>: JSON status. 202 while queued or rendering, 200 when the MP4 is ready. */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown video job", 404);
  const job = getImageJob(id);
  if (!job) return errorJson("This video job expired or the server restarted — try again", 404);
  const seconds = Math.round((Date.now() - job.createdAt) / 1000);
  if (job.status === "pending") {
    return Response.json(
      {
        id,
        status: "pending",
        seconds,
        ...(job.meta ? { stage: job.meta.stage, detail: job.meta.detail, queue_position: job.meta.queue_position, eta_s: job.meta.eta_s } : {})
      },
      { status: 202, headers: { "cache-control": "no-store" } }
    );
  }
  if (job.status === "failed") return errorJson(job.error, job.httpStatus || 502);
  return Response.json(
    {
      id,
      status: "done",
      seconds,
      bytes: job.png?.byteLength ?? 0,
      model: job.headers["x-video-model"] ?? null,
      adult: job.headers["x-adult"] === "1",
      video: `/api/chat/video/${id}/video`
    },
    { headers: { "cache-control": "no-store" } }
  );
}
