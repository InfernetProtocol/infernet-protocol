import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { getOrderPricing, updateOrderPricing, pricingView } from "@/lib/data/order-pricing";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/admin/orders/pricing → { min_margin_pct, range, classes[] (cost, price, setup) }
 * POST /api/v1/admin/orders/pricing  { min_margin_pct: 1..2000 }
 * Self-serve orders sell at cost * (1 + min_margin_pct/100). Default 100%.
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN
 */
export async function GET(request) {
    const { error } = requireAdmin(request);
    if (error) return error;
    return ok(pricingView(await getOrderPricing()));
}

export async function POST(request) {
    const { actor, error } = requireAdmin(request);
    if (error) return error;
    const body = await request.json().catch(() => ({}));
    try {
        return ok(pricingView(await updateOrderPricing(body, { actor })));
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
