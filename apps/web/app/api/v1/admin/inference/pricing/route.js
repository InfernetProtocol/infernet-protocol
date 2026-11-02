import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { getInferencePricing, updateInferencePricing } from "@/lib/data/billing";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/admin/inference/pricing   the live paid-batch pricing
 * POST /api/v1/admin/inference/pricing   { enabled?, models?, min_topup_usd?,
 *      max_items_per_batch?, max_tokens_cap?, max_in_flight? }  (merged)
 *
 * Settings row 'inference_pricing'. enabled:false is the kill switch: new
 * quotes and submits stop at once; running batches finish.
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    return ok(await getInferencePricing());
}

export async function POST(request) {
    const { actor, error } = await requireAdmin(request);
    if (error) return error;
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
    try {
        return ok(await updateInferencePricing(body, { actor }));
    } catch (e) {
        return fail(e.status ?? 500, e.message);
    }
}
