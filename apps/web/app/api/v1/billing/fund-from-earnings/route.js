import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { fundFromEarnings } from "@/lib/data/interactive-billing";
import { getBalance } from "@/lib/data/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/billing/fund-from-earnings — spend what your nodes earned.
 *
 *   { }                 move everything confirmed
 *   { amount_usd: 1.5 } move part of it
 *
 * Earnings could already fund a paid BATCH (funding_order "earned"), but only
 * as part of submitting one. This moves them into the compute balance on their
 * own, so they also pay for interactive inference — chat, /v1/chat/completions,
 * the CLI, c0mpute.com.
 *
 * One way. The transfer writes a negative provider_earnings row of kind
 * 'spent_on_compute', so the same dollars drop out of provider_available_usd
 * and payout_requests_guard refuses to pay them out. Nothing here moves a
 * compute balance back into withdrawable earnings.
 */
export async function POST(request) {
    const { user, error } = await requireCaller(request);
    if (error) return error;

    let body = {};
    if (request.headers.get("content-length") && request.headers.get("content-length") !== "0") {
        try {
            body = (await request.json()) ?? {};
        } catch {
            return fail(400, "invalid JSON body");
        }
    }

    try {
        const moved = await fundFromEarnings({
            userId: user.id,
            amountUsd: body?.amount_usd ?? body?.amountUsd ?? null
        });
        return ok({ ...moved, balance: await getBalance(user, { recent: 5 }) });
    } catch (e) {
        return failFrom(e);
    }
}
