import { NextResponse } from "next/server";
import { capacity, ORDER_TERMS, MAX_ORDER_HOURS, nextWholeHour } from "@/lib/reservations/orders";
import { onlineProviders, bookings } from "@/lib/data/reservation-orders";
import { x402Configured } from "@/lib/reservations/order-payment";
import { getOrderPricing } from "@/lib/data/order-pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/orders/capacity — what can be ordered right now: per GPU class,
 * the price (our cost plus the house margin), how many online nodes are free from the next hour, and the
 * models they serve. Public.
 */
export async function GET() {
    try {
        const [providers, booked, pricing] = await Promise.all([onlineProviders(), bookings(), getOrderPricing()]);
        return NextResponse.json({
            data: {
                currency: "USD",
                terms: ORDER_TERMS,
                earliest_start: nextWholeHour().toISOString(),
                max_hours: MAX_ORDER_HOURS,
                pay: { x402: x402Configured(), checkout: true },
                order: "POST /api/v1/orders { gpu_class, models[], hours, start_at? }",
                classes: capacity(providers, booked, Date.now(), pricing.min_margin_pct)
            }
        }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
        console.error("[orders/capacity]", e?.message ?? e);
        return NextResponse.json({ error: "capacity lookup failed" }, { status: 500 });
    }
}
