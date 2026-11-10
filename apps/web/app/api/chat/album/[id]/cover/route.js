import { errorJson } from "@/lib/chat/speech-service";
import { albumCover } from "@/lib/chat/album-package";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/chat/album/<id>/cover: the album cover (image/png) once it is drawn; 404 before. */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown album", 404);
  const png = await albumCover(id);
  if (!png) return errorJson("No cover art for this album (yet)", 404);
  return new Response(png, { status: 200, headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } });
}
