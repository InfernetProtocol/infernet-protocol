import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { getCreditDeps } from "@/lib/credits";

export const dynamic = "force-dynamic";

/** DELETE /api/v1/admin/credit-codes/{id} — revoke a code (idempotent). Admin only. */
export async function DELETE(request, { params }) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    const { id } = await params;
    try {
        await getCreditDeps().credits.revoke(String(id));
        return ok({ id, revoked: true });
    } catch (err) {
        return fail(/unknown/i.test(err.message) ? 404 : 500, err.message);
    }
}
