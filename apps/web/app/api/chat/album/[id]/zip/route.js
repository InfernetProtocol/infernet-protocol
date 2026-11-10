import { errorJson } from "@/lib/chat/speech-service";
import { albumJobs } from "@/lib/chat/album-jobs";
import { buildAlbumZip } from "@/lib/chat/album-package";
import { attachmentHeader } from "@/lib/billing/album";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/chat/album/<id>/zip: the finished album as one zip:
 * "Band - Album/" with cover.jpg, album.txt, "NN - Title.mp3" (ID3-tagged
 * with lyrics and cover) and "NN - Title-lyrics.txt" per track.
 */
export async function GET(_request, { params }) {
  const { id } = await params;
  if (!UUID.test(String(id))) return errorJson("Unknown album", 404);
  const job = albumJobs.get(id);
  const rec = job ? null : await albumJobs.find(id);
  const status = job?.status ?? rec?.status;
  if (!status) return errorJson("This album expired", 404);
  if (status === "pending") return errorJson("The album is still being made", 409);
  if (status === "failed") return errorJson(job?.error ?? rec?.error ?? "Album failed", 410);
  let built;
  try {
    built = await buildAlbumZip(id, { albumJob: job, meta: job?.meta ?? rec?.meta ?? {} });
  } catch (e) {
    console.warn(`[album] zip ${id}: ${e?.message ?? e}`);
    return errorJson("Could not package the album", 500);
  }
  if (!built?.tracks) return errorJson("The album's tracks have expired", 410);
  return new Response(built.zip, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(built.zip.length),
      "content-disposition": attachmentHeader(built.name),
      "cache-control": "private, no-store"
    }
  });
}
