import { priceList } from "@/lib/reservations/pricing";
import { ok } from "@/lib/reservations/http";

export const runtime = "nodejs";

/**
 * GET /api/v1/reservations/pricing — public managed-endpoint price list by
 * GPU class (apps/web/lib/reservations/pricing.js). No auth: it is a rate card.
 */
export async function GET() {
    return ok(priceList());
}
