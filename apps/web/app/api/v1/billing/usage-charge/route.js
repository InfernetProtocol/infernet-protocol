import { ok, fail } from "@/lib/reservations/http";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, billedSubjectFrom } from "@/lib/trusted-clients";
import { validateUsageCharge } from "@/lib/billing/usage";
import { chargeUsageForSubject } from "@/lib/data/usage-charge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/billing/usage-charge: bill one of a trusted client's signed-in
 * people for metered, non-inference work, and credit the node that did it.
 *
 *   Authorization: Bearer ifc_...            a trusted client (lib/trusted-clients.js)
 *   X-Infernet-Billed-Subject: <CoinPay sub> who pays
 *   { idem_key, kind: "live.relay", cost_usd, provider: "c0mpute:<peer_id>", meta? }
 *   { idem_key, kind: "board.meeting", cost_usd, provider: "house", meta? }   (no node: house revenue)
 *
 *   200 { data: { charged: true, cost_usd, operator_usd, fee_usd, balance_usd } }
 *   200 { data: { charged: false, reason: "insufficient_balance" | "no_account", balance_usd } }
 *
 * c0mpute Live meters relay bytes per node and calls this with the total the
 * streamer owes that node (cost_usd, at most 50 a call). The node keeps its
 * share, the house keeps the same fee as on inference, and a referrer's
 * commission comes out of that fee. It is recorded as one billed job would be
 * (lib/billing/usage.js), so it shows in the same earnings, payout and
 * referral views, with the kind as its label.
 *
 * All or nothing: when the balance (plus confirmed node earnings) does not
 * cover cost_usd, nothing is charged and nobody is credited.
 *
 * Idempotent on idem_key, per client: a repeat returns the original amounts
 * and moves nothing. A call that was refused for an empty balance recorded
 * nothing, so the same key may be sent again after a top-up. The same key
 * with a different person, amount, node or kind is a 409.
 *
 * Only a trusted key may call this, for the same reason only one may name a
 * billed subject: otherwise any caller could spend a stranger's balance.
 */
export async function POST(request) {
    const bearer = bearerFrom(request.headers.get("authorization"));
    if (!bearer) return fail(401, "a trusted client key is required (Authorization: Bearer ifc_...)");
    const trusted = trustedClientFor(bearer);
    if (!trusted) return fail(403, "this endpoint is for trusted clients only");

    const subject = await billedSubjectFrom(request, trusted);
    if (!subject) return fail(400, "name the person to charge with X-Infernet-Billed-Subject (their CoinPay sub)");

    let body;
    try {
        body = await request.json();
    } catch {
        return fail(400, "invalid JSON body");
    }
    const input = validateUsageCharge(body);
    if (!input.ok) return fail(input.status, input.error);

    try {
        return ok(await chargeUsageForSubject({ subject, client: trusted.name, input: input.value }));
    } catch (e) {
        const status = Number.isInteger(e?.status) ? e.status : 500;
        if (status >= 500) console.error("[usage-charge]", e?.message ?? e);
        return fail(
            status,
            status >= 500 && !e?.code ? "could not record that charge; retry with the same idem_key" : e.message,
            e?.code ? { code: e.code } : {}
        );
    }
}
