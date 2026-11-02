import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { openTopup } from "@/lib/data/billing";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

/**
 * POST /api/v1/billing/topup { amount_usd }  -> a CoinPay checkout (any coin or PayPal).
 * The balance is credited only once CoinPay confirms the full amount was
 * collected: the webhook, or GET /api/v1/billing/topup/:id (which asks CoinPay).
 */
export async function POST(request) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    const r = limit.check(`${user.id}:${getClientIp(request)}`);
    if (!r.ok) return fail(429, "too many top-ups opened; pay or wait", { reset_at: new Date(r.resetAt).toISOString() });
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
    try {
        return ok(await openTopup(user, body?.amount_usd), 201);
    } catch (e) {
        return failFrom(e);
    }
}
