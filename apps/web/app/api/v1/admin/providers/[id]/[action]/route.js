import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { setProviderDisabled } from "@/lib/data/provider-admin";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/admin/providers/<id>/disable  { reason? }
 * POST /api/v1/admin/providers/<id>/enable
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN
 *
 * Disable is durable: the node's heartbeats and re-registers cannot undo it.
 * A disabled node gets no chat jobs, no orders, no reservations, no earnings.
 */
export async function POST(request, { params }) {
    const { actor, error } = await requireAdmin(request);
    if (error) return error;
    const { id, action } = await params;
    if (action !== "disable" && action !== "enable") return fail(404, "action must be disable or enable");
    const body = await request.json().catch(() => ({}));
    try {
        return ok(await setProviderDisabled(id, { disabled: action === "disable", reason: body?.reason ?? null, actor }));
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
