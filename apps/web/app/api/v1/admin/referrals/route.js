import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { getReferralResults } from "@/lib/data/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/referrals?active_days=7
 * The node-referral experiment by arm (12m vs lifetime): referrers, referred
 * nodes, active referred nodes, referred-node revenue, house fee, commissions
 * accrued / confirmed / paid. Authorization: INFERNET_ADMIN_TOKEN or an admin
 * sign-in.
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    try {
        const days = Number(new URL(request.url).searchParams.get("active_days"));
        return ok(await getReferralResults({ activeDays: Number.isInteger(days) && days > 0 && days <= 90 ? days : 7 }));
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
