import { errorJson } from "@/lib/chat/speech-service";
import { getMusicCover } from "@/lib/chat/music-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/chat/music/<id>/cover: the song's cover art (image/png) once the
 * poll reports `cover: "ready"`; 404 before that or after it expires.
 */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown music job", 404);
  const png = getMusicCover(id);
  if (!png) return errorJson("No cover art for this song (yet)", 404);
  return new Response(png, { status: 200, headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
}
