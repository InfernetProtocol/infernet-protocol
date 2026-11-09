import { errorJson, fetchSpeechGateway } from "@/lib/chat/speech-service";
import { getMusicJob, musicJobs, takeMusicJob } from "@/lib/chat/music-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/chat/music/<id>: 202 while generating, then the audio once, or the error. */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown music job", 404);
  const job = getMusicJob(id);
  if (!job) {
    // Not this process's job: a restart (a deploy) or another container.
    // The media store has its record, and the song once it is done.
    const rec = await musicJobs.find(id);
    if (rec?.status === "pending") {
      return Response.json(
        { id, status: "pending", seconds: Math.round((Date.now() - (rec.createdAt ?? Date.now())) / 1000), ...(rec.meta ?? {}), resumed: true },
        { status: 202, headers: { "cache-control": "no-store" } }
      );
    }
    if (rec?.status === "failed") return errorJson(rec.error || "Music generation failed", rec.httpStatus || 502);
    if (rec?.status === "done") {
      const bytes = await musicJobs.song(rec);
      if (bytes) {
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": rec.result.contentType || "audio/mpeg", "cache-control": "no-store", ...(rec.result.headers ?? {}) }
        });
      }
    }
    // No record (an older job, or no store): the
    // c0mpute gateway (>= 0.2.90) keeps running it under our id: ask it.
    const res = await fetchSpeechGateway(`/v1/result/${id}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.status === 202) {
      const p = await res.json().catch(() => ({}));
      return Response.json(
        { id, status: "pending", seconds: Number.isFinite(p.elapsed_s) ? p.elapsed_s : null, stage: "composing", node: p, resumed: true },
        { status: 202, headers: { "cache-control": "no-store" } }
      );
    }
    const type = (res?.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (res?.status === 200 && type.startsWith("audio/")) {
      const worker = res.headers.get("x-c0mpute-worker-peer-id");
      return new Response(res.body, {
        status: 200,
        headers: { "content-type": type, "cache-control": "no-store", "x-music-model": "ace-step-1.5", ...(worker ? { "x-c0mpute-worker-peer-id": worker } : {}) }
      });
    }
    await res?.body?.cancel().catch(() => {});
    return errorJson("This music job expired or the server restarted — try again", 404);
  }
  if (job.status === "pending") {
    return Response.json(
      { id, status: "pending", seconds: Math.round((Date.now() - job.createdAt) / 1000), ...(job.meta ?? {}) },
      { status: 202, headers: { "cache-control": "no-store" } }
    );
  }
  if (job.status === "failed") return errorJson(job.error, job.httpStatus || 502);
  const done = takeMusicJob(id);
  return new Response(done.audio, {
    status: 200,
    headers: { "content-type": done.contentType || "audio/mpeg", "cache-control": "no-store", ...done.headers }
  });
}
