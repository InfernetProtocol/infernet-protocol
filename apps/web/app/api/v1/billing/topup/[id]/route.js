import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { getTopup, settleTopup, publicTopup } from "@/lib/data/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/billing/topup/:id
 * While unpaid, each call asks CoinPay whether the full amount was
 * collected and credits the balance exactly once if so. Nothing the caller
 * says about payment is believed.
 */
export async function GET(request, { params }) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    const { id } = await params;
    try {
        const topup = await getTopup(id);
        if (!topup || topup.user_id !== user.id) return fail(404, "top-up not found");
        if (topup.status !== "awaiting_payment") return ok(publicTopup(topup));
        const s = await settleTopup(topup);
        return ok({ ...publicTopup(s.topup), verified: s.verdict, credited: s.credited });
    } catch (e) {
        return failFrom(e);
    }
}
