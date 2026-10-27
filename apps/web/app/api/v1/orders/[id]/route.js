import { NextResponse } from "next/server";
import { checkoutClient, sessionState } from "@profullstack/x402-gateway";
import { getPayment } from "@infernetprotocol/payments";
import { getOrder, orderTokenMatches, fulfilOrder, publicOrder, HOLD_MS } from "@/lib/data/reservation-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/orders/:id  (X-Buyer-Token or ?token=)
 *
 * The order and, once paid, its reservation. While a checkout order is
 * unpaid, each call asks CoinPay for the payment's state, so a buyer who
 * polls is booked even if the webhook is late. Nothing the caller says about
 * payment is believed.
 */
const env = (name) => process.env[name];

function fail(status, error) {
    return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

async function paidAtCoinpay(ref, totalUsd) {
    const apiKey = env("COINPAY_API_KEY") || env("COINPAYPORTAL_API_KEY");
    // COINPAY_API_URL carries an /api suffix; checkout paths add their own.
    const baseUrl = (env("COINPAY_API_URL") || "https://coinpayportal.com").replace(/\/+$/, "").replace(/\/api$/, "");
    if (!apiKey || !ref) return false;
    try {
        const session = await checkoutClient({ apiKey, baseUrl }).get(ref);
        if (session) {
            const st = sessionState(session);
            return st.paid && (st.cents === null || st.cents >= Math.round(totalUsd * 100));
        }
    } catch { /* not a session: try it as a payment */ }
    try {
        const p = await getPayment(ref);
        return ["confirmed", "completed", "forwarded", "paid"].includes(String(p?.status ?? "").toLowerCase());
    } catch {
        return false;
    }
}

export async function GET(request, { params }) {
    const { id } = await params;
    try {
        const order = await getOrder(id);
        if (!order) return fail(404, "order not found");
        const token = request.headers.get("x-buyer-token") || new URL(request.url).searchParams.get("token");
        if (!orderTokenMatches(order, token)) return fail(401, "the order's buyer token is required (X-Buyer-Token)");

        let current = order;
        const fresh = Date.now() - Date.parse(order.created_at) <= HOLD_MS * 2;
        if (order.status === "awaiting_payment" && order.rail === "checkout" && fresh && await paidAtCoinpay(order.payment_ref, order.total_usd)) {
            current = (await fulfilOrder(order)).order;
        }
        return NextResponse.json({ data: await publicOrder(current) }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
        const status = Number.isInteger(e?.status) ? e.status : 500;
        console.error("[orders/:id]", e?.message ?? e);
        return fail(status, e?.message ?? String(e));
    }
}
