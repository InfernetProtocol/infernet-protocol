import { NextResponse } from "next/server";
import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { prepareSubmit, commitSubmit, publicBatch } from "@/lib/data/batches";
import { fundingPreview, creditWalletPayment, openTopup } from "@/lib/data/billing";
import { planFunding, shortfallCents, microToUsd } from "@/lib/billing/core";
import { paymentFrom, settleOrderPayment, settlementHeader, x402Configured } from "@/lib/reservations/order-payment";
import { batchOffer, batchOfferHeaders } from "@/lib/billing/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/batches  (Bearer ik_live_... or signed in)
 *   { quote_id } or { model, items },
 *   max_cost_usd     required hard cap,
 *   idempotency_key  required; the same key returns the same batch,
 *   funding?         earned_first | prepaid_first | earned_only | prepaid_only | no_wallet,
 *                    or a list of "earned","prepaid","wallet" (default: your funding order)
 *   pay?             "checkout": when balances fall short, open a CoinPay
 *                    checkout for the shortfall instead of an x402 offer
 *
 * The total max cost is held atomically from the funding sources in order.
 * If they fall short and 'wallet' is allowed: 402 with an x402 offer for the
 * shortfall (send it back with X-PAYMENT / PAYMENT-SIGNATURE and the batch is
 * placed in the same request), or a checkout_url with pay: "checkout".
 */
function insufficient(r, extra = {}, headers = {}) {
    return NextResponse.json({
        error: "insufficient balance for the batch hold",
        needed_usd: microToUsd(r.needed_micro ?? 0),
        shortfall_usd: microToUsd(r.shortfall_micro ?? 0),
        earned_spendable_usd: microToUsd(r.earned_spendable_micro ?? 0),
        prepaid_available_usd: microToUsd(r.prepaid_available_micro ?? 0),
        ...extra
    }, { status: 402, headers: { "cache-control": "no-store", ...headers } });
}

export async function POST(request) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
    try {
        const preview = await fundingPreview(user.id);
        const p = await prepareSubmit(user, body, { accountOrder: preview.funding_order });
        if (p.existing) return ok({ ...publicBatch(p.existing, []), items: undefined, replayed: true });

        const plan = planFunding({
            sources: p.sources,
            totalMicro: p.totalMicro,
            earnedMicro: Number(preview.earned_spendable_micro ?? 0),
            prepaidMicro: Number(preview.prepaid_available_micro ?? 0)
        });
        let walletMicro = 0;
        let headers = {};
        if (plan.shortfall > 0) {
            const base = {
                needed_micro: p.totalMicro, shortfall_micro: plan.shortfall,
                earned_spendable_micro: preview.earned_spendable_micro, prepaid_available_micro: preview.prepaid_available_micro
            };
            if (!plan.walletAllowed) return insufficient(base, { funding: p.sources, hint: "top up (POST /api/v1/billing/topup) or allow 'wallet' in funding" });
            const cents = shortfallCents(plan.shortfall);
            if (body?.pay === "checkout") {
                const t = await openTopup(user, (cents / 100).toFixed(2));
                return insufficient(base, { funding: p.sources, checkout_url: t.checkout_url, topup: t.topup, next: "Pay at checkout_url, wait until GET /api/v1/billing/topup/:id shows paid, then POST the same body again (same idempotency_key)." });
            }
            if (!x402Configured()) return insufficient(base, { funding: p.sources, hint: "x402 is not configured here; send pay: \"checkout\" for a CoinPay checkout" });
            const offer = batchOffer(cents);
            const payment = paymentFrom(request);
            if (!payment) {
                return insufficient(base, { ...offer, funding: p.sources, checkout: "or POST the same body with pay: \"checkout\" for a CoinPay checkout URL" }, batchOfferHeaders(offer));
            }
            const settled = await settleOrderPayment(payment, offer, { kind: "batch_shortfall", user_id: user.id, idempotency_key: p.key });
            if (!settled.ok) return insufficient(base, { ...offer, error: `payment refused: ${settled.reason}` }, batchOfferHeaders(offer));
            walletMicro = cents * 10_000;
            await creditWalletPayment(user, { amountMicro: walletMicro, nonce: settled.nonce ?? settled.ref, txHash: settled.txHash ?? null });
            headers = settlementHeader(settled, payment);
        }

        const r = await commitSubmit(user, p, { walletMicro });
        if (!r.ok) {
            if (r.reason === "insufficient_balance") {
                return insufficient(r, walletMicro ? { note: "your wallet payment was credited to your compute balance; balances changed meanwhile, submit again" } : {});
            }
            return fail(400, r.reason ?? "submit refused", r);
        }
        const res = ok({ ...publicBatch(r.batch, []), items: undefined, replayed: r.existing }, r.existing ? 200 : 201);
        for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
        return res;
    } catch (e) {
        return failFrom(e, "batches");
    }
}
