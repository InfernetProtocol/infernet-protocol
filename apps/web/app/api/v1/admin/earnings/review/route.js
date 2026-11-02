import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { listEarningsForReview, reviewEarning } from "@/lib/data/earnings";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/admin/earnings/review → credits waiting for an admin: reservation
 *      earnings (operator share of a prepaid order) and held subsidy outliers
 * POST /api/v1/admin/earnings/review  { earning_id, action: "approve" | "void", note? }
 * Only an approved (confirmed) credit counts toward a provider's withdrawable balance.
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    const rows = await listEarningsForReview({ limit: new URL(request.url).searchParams.get("limit") });
    return ok({ count: rows.length, rows });
}

export async function POST(request) {
    const { actor, error } = await requireAdmin(request);
    if (error) return error;
    const body = await request.json().catch(() => ({}));
    try {
        return ok(await reviewEarning(String(body?.earning_id ?? ""), { action: body?.action, actor, note: body?.note }));
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
