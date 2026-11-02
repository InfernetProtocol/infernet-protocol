import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { getRevenue } from "@/lib/data/revenue";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/revenue?from=<iso>&to=<iso>   (default: the last 30 days)
 *
 * External paid GMV (paid reservation orders less refunds, plus jobs whose
 * client payment was confirmed), the platform fee kept, refunds due and paid
 * back, and provider payouts sent. The house subsidy, the hosted NIM
 * fallback, unpaid jobs, admin post-paid reservations and internal orders
 * are excluded (counted under `excluded`). See lib/earnings/revenue.js.
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    const q = new URL(request.url).searchParams;
    try {
        return ok(await getRevenue({ from: q.get("from"), to: q.get("to") }));
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
