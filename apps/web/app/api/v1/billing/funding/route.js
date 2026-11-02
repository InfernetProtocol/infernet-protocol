import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { setFundingOrder, fundingPreview } from "@/lib/data/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/billing/funding                  your funding order
 * PUT /api/v1/billing/funding { funding_order: ["earned","prepaid","wallet"] }
 * The order batch holds are covered in; a submit can override it with `funding`.
 */
export async function GET(request) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    try { return ok({ funding_order: (await fundingPreview(user.id)).funding_order }); } catch (e) { return failFrom(e); }
}

export async function PUT(request) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
    try { return ok({ funding_order: await setFundingOrder(user, body?.funding_order) }); } catch (e) { return failFrom(e); }
}
