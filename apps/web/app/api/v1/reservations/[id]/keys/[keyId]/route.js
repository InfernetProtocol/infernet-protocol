import { revokeKey } from "@/lib/data/reservations";
import { loadForReader, fail, ok, guard } from "@/lib/reservations/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/reservations/:id/keys/:keyId — revoke; takes effect on the
 * next request. Admin or the reservation's buyer token.
 */
export async function DELETE(request, { params }) {
    const { id, keyId } = await params;
    return guard(async () => {
        const r = await loadForReader(request, id);
        if (r.error) return r.error;
        const k = await revokeKey(id, keyId);
        return k ? ok(k) : fail(404, "key not found or already revoked");
    });
}
