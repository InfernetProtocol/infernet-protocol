import { errorJson, fetchSpeechGateway } from "@/lib/chat/speech-service";
import { cancelImageJob, getImageJob } from "@/lib/chat/image-jobs";
import { cancelClip, clipJobs } from "@/lib/video/clip-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/chat/video/<id>: JSON status. 202 while queued or rendering, 200 when the MP4 is ready. */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown video job", 404);
  const clip = getImageJob(id) ? null : await clipJobs.find(id);
  if (clip) return clipStatus(clip);
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
  if (job.status === "cancelled") return errorJson("Cancelled", 410);
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

/** A long (multi-shot) clip's status, in the same shape as a one-shot clip's. */
function clipStatus(job) {
  const id = job.id;
  const seconds = Math.round(((job.finishedAt ?? Date.now()) - job.createdAt) / 1000);
  const m = job.meta ?? {};
  if (job.status === "pending") {
    return Response.json(
      {
        id,
        status: "pending",
        seconds,
        stage: m.stage ?? "starting",
        detail: m.detail,
        queue_position: m.queue_position,
        eta_s: m.eta_s,
        shots: m.shots ?? job.request?.shots,
        shots_done: m.shots_done ?? 0,
        clip_seconds: job.request?.seconds
      },
      { status: 202, headers: { "cache-control": "no-store" } }
    );
  }
  if (job.status === "failed") return errorJson(job.error ?? "Video generation failed", job.httpStatus || 502);
  const r = job.result ?? {};
  return Response.json(
    {
      id,
      status: "done",
      seconds,
      bytes: r.bytes ?? 0,
      duration: typeof r.duration === "number" ? Math.round(r.duration * 10) / 10 : null,
      shots: r.shots ?? null,
      model: r.model ?? job.request?.model ?? null,
      adult: Boolean(r.adult),
      ...(m.charged_usd ? { charged_usd: m.charged_usd } : {}),
      video: `/api/chat/video/${id}/video`
    },
    { headers: { "cache-control": "no-store" } }
  );
}

/**
 * DELETE /api/chat/video/<id>: stop the clip. Cancels the gateway's request
 * (and the first-frame request of a keyframe clip) so it leaves the queue at
 * once instead of waiting up to 2 h in front of later clips; a job a worker
 * already took is cancelled on that worker. Idempotent; the id is the
 * capability, as for GET.
 */
export async function DELETE(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown video job", 404);
  if (!getImageJob(id)) {
    const clip = await cancelClip(id);
    if (clip) {
      if (clip.status === "done") return errorJson("This video already finished", 409);
      return Response.json({ id, status: "cancelled", gateway: "cancelled" }, { headers: { "cache-control": "no-store" } });
    }
  }
  const job = cancelImageJob(id);
  if (!job) return errorJson("This video job expired or the server restarted", 404);
  if (job.status === "done") return errorJson("This video already finished", 409);
  const results = await Promise.all(
    [id, `${id}-keyframe`].map((rid) =>
      fetchSpeechGateway(`/v1/result/${encodeURIComponent(rid)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) })
        .then(async (res) => {
          await res?.body?.cancel().catch(() => {});
          return res?.status ?? 0;
        })
        .catch(() => 0)
    )
  );
  return Response.json(
    { id, status: "cancelled", gateway: results[0] === 200 ? "cancelled" : results[0] === 404 ? "not_queued" : "unreachable" },
    { headers: { "cache-control": "no-store" } }
  );
}
