import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { listPayoutRequests, getLedgerTotals } from "@/lib/data/earnings";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/payouts?status=requested|sending|sent|all
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN (or an admin CLI login)
 * → { rows, totals }
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    try {
        const status = new URL(request.url).searchParams.get("status") ?? "requested";
        const [list, totals] = await Promise.all([listPayoutRequests({ status }), getLedgerTotals()]);
        return ok({ rows: list.rows, totals });
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
