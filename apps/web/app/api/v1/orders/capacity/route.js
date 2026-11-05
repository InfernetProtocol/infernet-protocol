import { NextResponse } from "next/server";
import { capacity, ORDER_TERMS, MAX_ORDER_HOURS, nextWholeHour } from "@/lib/reservations/orders";
import { onlineProviders, bookings } from "@/lib/data/reservation-orders";
import { x402Configured } from "@/lib/reservations/order-payment";
import { getOrderPricing } from "@/lib/data/order-pricing";
import { rentalAvailability, rentalProviderStatus } from "@/lib/data/rental";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/orders/capacity — what can be ordered right now: per GPU class,
 * the price (our cost plus the house margin), how many online nodes are free
 * from the next hour, and the models they serve. Rented classes (SaladCloud,
 * Vast.ai, Thunder Compute) are on demand with no node count, and `available`
 * means orderable this minute — an account plus, where the provider has one, a
 * live offer or free capacity. Public.
 */
export async function GET() {
    try {
        const [providers, booked, pricing, rented] = await Promise.all([onlineProviders(), bookings(), getOrderPricing(), rentalAvailability()]);
        return NextResponse.json({
            data: {
                currency: "USD",
                terms: ORDER_TERMS,
                earliest_start: nextWholeHour().toISOString(),
                max_hours: MAX_ORDER_HOURS,
                pay: { x402: x402Configured(), checkout: true },
                order: "POST /api/v1/orders { gpu_class, models[], hours, start_at? }",
                providers: rentalProviderStatus(),
                classes: capacity(providers, booked, Date.now(), pricing.min_margin_pct, { rented })
            }
        }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
        console.error("[orders/capacity]", e?.message ?? e);
        return NextResponse.json({ error: "capacity lookup failed" }, { status: 500 });
    }
}
