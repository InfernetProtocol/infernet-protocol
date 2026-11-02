import { ok } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { getBalance } from "@/lib/data/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/billing/balance
 * Compute balance (prepaid + wallet), holds, earned_spendable (confirmed node
 * earnings you can spend on compute), per-source breakdown, funding order,
 * recent ledger rows.
 */
export async function GET(request) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    try { return ok(await getBalance(user)); } catch (e) { return failFrom(e); }
}
