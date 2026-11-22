import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, trustedSubjectCaller, accountEmail, failFrom } from "@/lib/billing/http";
import { openTopup } from "@/lib/data/billing";
import { parseReturnUrls } from "@/lib/billing/topup-return";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

/**
 * POST /api/v1/billing/topup { amount_usd }  -> a CoinPay checkout (any coin or PayPal).
 * The balance is credited only once CoinPay confirms the full amount was
 * collected: the webhook, or GET /api/v1/billing/topup/:id (which asks CoinPay).
 *
 * A trusted client of ours (lib/trusted-clients.js) may open a top-up for one
 * of its own signed-in people, the same way it reads their balance:
 *
 *   Authorization: Bearer ifc_...
 *   X-Infernet-Billed-Subject: <their CoinPay sub>
 *   { amount_usd, success_url?, cancel_url? }
 *
 * That is how c0mpute.com sells compute credit on its own checkout page. The
 * top-up belongs to the account the subject is bound to, so the webhook
 * credits that account with nothing else changed. Only a trusted client may
 * set the return URLs, and only to an allowlisted https origin
 * (lib/billing/topup-return.js); from anyone else they are ignored.
 *
 *   400 missing_subject          trusted key, no subject header
 *   404 subject_not_linked       POST /api/v1/coinpay/link-trusted, then retry
 *   400 return_url_not_allowed   success_url / cancel_url off the allowlist
 */
export async function POST(request) {
    const acting = await trustedSubjectCaller(request);
    if (acting) return trustedTopup(request, acting);

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

async function trustedTopup(request, acting) {
    if (acting.error) return acting.error;
    const { user } = acting;
    // The IP is the client's server, so the budget is per account alone.
    const r = limit.check(user.id);
    if (!r.ok) return fail(429, "too many top-ups opened; pay or wait", { reset_at: new Date(r.resetAt).toISOString() });
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
    const urls = parseReturnUrls(body);
    if (!urls.ok) {
        return fail(400, "return_url_not_allowed", {
            field: urls.field,
            message: `${urls.field} must be an absolute https URL on an allowed origin`
        });
    }
    try {
        const email = await accountEmail(user.id);
        return ok(await openTopup({ ...user, email }, body?.amount_usd, {
            successUrl: urls.successUrl,
            cancelUrl: urls.cancelUrl,
            // No real address on most of these accounts: CoinPay then gets a
            // stable per-account one instead of one per order.
            accountId: user.id
        }), 201);
    } catch (e) {
        return failFrom(e);
    }
}
