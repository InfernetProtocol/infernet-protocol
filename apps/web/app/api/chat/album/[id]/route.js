import { errorJson } from "@/lib/chat/speech-service";
import { albumJobs } from "@/lib/chat/album-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/chat/album/<id>: the album's plan and every track's progress.
 * 202 while it is being made, 200 once done (with `zip` and `cover` links),
 * or the error. A finished track's audio is at /api/chat/music/<track id>.
 */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown album", 404);
  const job = albumJobs.get(id);
  const rec = job ? null : await albumJobs.find(id);
  const status = job?.status ?? rec?.status;
  if (!status) return errorJson("This album expired or the server restarted — try again", 404);
  if (status === "failed") return errorJson(job?.error ?? rec?.error ?? "Album failed", job?.httpStatus || rec?.httpStatus || 502);
  const meta = job?.meta ?? rec?.meta ?? {};
  const createdAt = job?.createdAt ?? rec?.createdAt ?? Date.now();
  const body = {
    id,
    status,
    seconds: Math.round(((status === "done" ? rec?.finishedAt ?? job?.final?.finishedAt : null) ?? Date.now()) / 1000 - createdAt / 1000),
    ...meta,
    ...(rec && status === "pending" ? { resumed: true } : {}),
    ...(status === "done" ? { zip: `/api/chat/album/${id}/zip` } : {}),
    ...(meta.cover === "ready" ? { coverUrl: `/api/chat/album/${id}/cover` } : {})
  };
  return Response.json(body, { status: status === "done" ? 200 : 202, headers: { "cache-control": "no-store" } });
}
