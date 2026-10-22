import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { getEarningsConfig, updateEarningsConfig, publicConfig } from "@/lib/data/earnings";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/admin/earnings/settings → live earnings config
 * POST /api/v1/admin/earnings/settings
 *   Body (any subset): { subsidy_per_1k_output_usd, subsidy_approved, house_fee_pct, min_payout_usd }
 *   Approving the subsidy confirms every subsidy credit still pending approval.
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN
 */
export async function GET(request) {
    const { error } = requireAdmin(request);
    if (error) return error;
    return ok(publicConfig(await getEarningsConfig()));
}

const KEYS = ["subsidy_per_1k_output_usd", "subsidy_approved", "house_fee_pct", "min_payout_usd"];

export async function POST(request) {
    const { actor, error } = requireAdmin(request);
    if (error) return error;
    const body = await request.json().catch(() => ({}));
    const patch = Object.fromEntries(KEYS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    if (Object.keys(patch).length === 0) return fail(400, `send one of: ${KEYS.join(", ")}`);
    try {
        const out = await updateEarningsConfig(patch, { actor });
        return ok({ ...out, config: publicConfig(out.config) });
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
