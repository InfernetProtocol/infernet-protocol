import { NextResponse } from "next/server";
import { getOrder, orderTokenMatches, fulfilOrder, publicOrder, verifyOrderAtCoinpayDetail } from "@/lib/data/reservation-orders";

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
function fail(status, error) {
    return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request, { params }) {
    const { id } = await params;
    try {
        const order = await getOrder(id);
        if (!order) return fail(404, "order not found");
        const token = request.headers.get("x-buyer-token") || new URL(request.url).searchParams.get("token");
        if (!orderTokenMatches(order, token)) return fail(401, "the order's buyer token is required (X-Buyer-Token)");

        let current = order;
        // A paid order is booked however late it is noticed; fulfilOrder refunds
        // one whose hours are over, and the DB refuses hours sold to someone else.
        if (order.status === "awaiting_payment" && order.rail === "checkout") {
            const check = await verifyOrderAtCoinpayDetail(order);
            if (check.verdict === "paid") current = (await fulfilOrder(order, { txHash: check.txHash })).order;
        }
        return NextResponse.json({ data: await publicOrder(current) }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
        const status = Number.isInteger(e?.status) ? e.status : 500;
        console.error("[orders/:id]", e?.message ?? e);
        return fail(status, e?.message ?? String(e));
    }
}
