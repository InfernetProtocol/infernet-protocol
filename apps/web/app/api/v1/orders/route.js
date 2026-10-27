import { NextResponse } from "next/server";
import { createCheckout } from "@infernetprotocol/payments";
import { validateOrderInput, quoteFor, pickNode, ORDER_TERMS } from "@/lib/reservations/orders";
import { onlineProviders, bookings, placeOrder, setPaymentRef, fulfilOrder, publicOrder, orderByPaymentRef } from "@/lib/data/reservation-orders";
import { orderOffer, offerHeaders, paymentFrom, settleOrderPayment, settlementHeader, siteUrl, x402Configured } from "@/lib/reservations/order-payment";
import { publicReservation } from "@/lib/data/reservations";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { getOrderPricing } from "@/lib/data/order-pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Self-serve reservation orders (docs/prd/16-managed-endpoints.md, "Self-serve orders").
 * No account needed: people and agents both order here.
 *
 *   POST /api/v1/orders  { gpu_class, models[], hours?, start_at?, name?, email?, provider_id?, pay? }
 *
 * The order is matched to an online node with that GPU class that already
 * serves every model, and priced at our cost plus the house minimum margin
 * (hours x price + setup fee, prepaid; lib/reservations/margin.js). Then, by how the caller pays:
 *
 *   - no proof, pay != "checkout"  -> 402 with an x402 offer (USDC on Base,
 *                                    Polygon or Ethereum) in the body and in
 *                                    PAYMENT-REQUIRED
 *   - X-PAYMENT / PAYMENT-SIGNATURE -> settled through CoinPay, then 201 with
 *                                    the reservation, the buyer token and a
 *                                    first API key, all in one answer
 *   - pay: "checkout"              -> 201 with a CoinPay checkout URL (any coin
 *                                    CoinPay takes, or PayPal) and the buyer
 *                                    token; the reservation is created when
 *                                    CoinPay confirms (webhook, or polling
 *                                    GET /api/v1/orders/:id)
 *
 * 409 when nothing online fits: we never take money for capacity we cannot pin.
 */

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 60 });
// An unpaid checkout holds its node for 90 minutes, so cap how many one IP can open.
const checkoutLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });

function fail(status, error, extra = {}, headers = {}) {
    return NextResponse.json({ error, ...extra }, { status, headers: { "cache-control": "no-store", ...headers } });
}

function ok(data, status = 200, headers = {}) {
    return NextResponse.json({ data }, { status, headers: { "cache-control": "no-store", ...headers } });
}

export async function POST(request) {
    const r = limit.check(getClientIp(request));
    if (!r.ok) return fail(429, "rate limit exceeded", { reset_at: new Date(r.resetAt).toISOString() });

    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
    const v = validateOrderInput(body);
    if (!v.ok) return fail(400, "invalid order", { details: v.errors });
    const value = v.value;

    try {
        const [providers, booked, pricing] = await Promise.all([onlineProviders(), bookings(), getOrderPricing()]);
        const quote = quoteFor(value.gpu_class, value.hours, pricing.min_margin_pct);
        const node = pickNode(providers, value, booked);
        if (!node) {
            return fail(409, "no online node fits this order right now", {
                hint: "GET /api/v1/orders/capacity lists the GPU classes and models on sale",
                order: { gpu_class: value.gpu_class, models: value.models, start_at: value.start_at, hours: value.hours }
            });
        }
        const summary = { ...quote, start_at: value.start_at, models: value.models, provider_id: node.id, operator_name: node.name, terms: ORDER_TERMS };

        if (body?.pay === "checkout") {
            const c = checkoutLimit.check(getClientIp(request));
            if (!c.ok) return fail(429, "too many unpaid checkouts from this address", { reset_at: new Date(c.resetAt).toISOString() });
            const { order, buyerToken } = await placeOrder({ value, quote, provider: node, rail: "checkout" });
            const base = siteUrl();
            const back = `${base}/order/${order.id}#token=${encodeURIComponent(buyerToken)}`;
            let checkout;
            try {
                checkout = await createCheckout({
                    amountUsd: quote.total_usd,
                    orderId: order.id,
                    description: `Infernet reservation: ${quote.label} for ${value.hours}h from ${value.start_at}`,
                    email: value.email,
                    metadata: { reservation_order_id: order.id },
                    successUrl: back,
                    cancelUrl: `${base}/order`,
                    idempotencyKey: `order:${order.id}`
                });
            } catch (e) {
                return fail(502, "could not open a CoinPay checkout", { detail: e?.message ?? String(e) });
            }
            await setPaymentRef(order.id, checkout.id);
            return ok({
                order: await publicOrder({ ...order, payment_ref: checkout.id }),
                buyer_token: buyerToken,
                checkout_url: checkout.paymentUrl,
                quote: summary,
                next: `Pay at checkout_url, then GET /api/v1/orders/${order.id} with X-Buyer-Token until status is fulfilled.`
            }, 201);
        }

        if (!x402Configured()) return fail(503, "x402 is not configured here; order with pay: \"checkout\"");
        const offer = orderOffer(quote);
        const payment = paymentFrom(request);
        if (!payment) {
            return NextResponse.json(
                { ...offer, error: "payment required", quote: summary, checkout: "or POST the same body with pay: \"checkout\" for a CoinPay checkout URL" },
                { status: 402, headers: { "cache-control": "no-store", ...offerHeaders(offer, offer.accepts?.[0]?.description) } }
            );
        }

        const settled = await settleOrderPayment(payment, offer, { kind: "reservation_order", gpu_class: value.gpu_class, hours: value.hours });
        if (!settled.ok) {
            if (settled.replay) {
                const seen = await orderByPaymentRef([settled.nonce, settled.ref]);
                if (seen) return fail(409, "this payment already bought an order", { order_id: seen.id, status: seen.status });
            }
            return NextResponse.json(
                { ...offer, error: `payment refused: ${settled.reason}` },
                { status: 402, headers: { "cache-control": "no-store", ...offerHeaders(offer) } }
            );
        }

        let placed;
        try {
            placed = await placeOrder({ value, quote, provider: node, rail: "x402", paymentRef: settled.nonce ?? settled.ref, payer: settled.payer });
        } catch (e) {
            console.error(`[orders] x402 PAID but not recorded: tx=${settled.txHash ?? settled.ref} payer=${settled.payer} $${quote.total_usd}: ${e?.message ?? e}`);
            throw Object.assign(new Error("payment received but the order could not be recorded; it will be refunded"), { status: 500 });
        }
        const { order, buyerToken } = placed;
        const done = await fulfilOrder(order, { withKey: true, payer: settled.payer });
        return ok({
            order: await publicOrder(done.order),
            reservation: done.reservation ? publicReservation(done.reservation) : null,
            buyer_token: buyerToken,
            api_key: done.key?.key ?? null,
            tx_hash: settled.txHash ?? null,
            use: {
                base_url: `${siteUrl()}/v1`,
                models: value.models,
                note: "Send the api_key as Authorization: Bearer to /v1/chat/completions; it works from start_at for the booked hours. Issue more with POST /api/v1/reservations/:id/keys and X-Buyer-Token."
            }
        }, 201, settlementHeader(settled, payment));
    } catch (e) {
        const status = Number.isInteger(e?.status) ? e.status : 500;
        console.error("[orders]", e?.message ?? e);
        return fail(status, e?.message ?? String(e));
    }
}
