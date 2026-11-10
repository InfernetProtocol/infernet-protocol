import { errorJson, fetchSpeechGateway } from "@/lib/chat/speech-service";
import { albumJobs } from "@/lib/chat/album-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/chat/album/<id>/cover: the album cover (image/png) once the poll says `cover: "ready"`. */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown album", 404);
  const png = albumJobs.getCover(id) ?? (await albumJobs.storedCover(id));
  if (!png) {
    const res = await fetchSpeechGateway(`/v1/result/${id}-cover`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.status === 200 && (res.headers.get("content-type") ?? "").startsWith("image/png")) {
      return new Response(res.body, { status: 200, headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
    }
    await res?.body?.cancel().catch(() => {});
    return errorJson("No cover art for this album (yet)", 404);
  }
  return new Response(png, { status: 200, headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
}
