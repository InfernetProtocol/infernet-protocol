import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { createQuote } from "@/lib/data/batches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/batches/quote { model, items: [{ custom_id, messages, max_tokens, temperature? }] }
 * Preflight: per-item and total max cost and a quote_id valid 15 minutes.
 * Read-only for money: it never touches the balance.
 */
export async function POST(request) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
    try { return ok(await createQuote(user, body), 201); } catch (e) { return failFrom(e, "batches"); }
}
