import { ok } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { batchReceipt } from "@/lib/data/batches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/batches/:id/receipt  model, counts, estimated tokens, prices, total charged, provider/platform split, funding source, timestamps. */
export async function GET(request, { params }) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    const { id } = await params;
    try { return ok(await batchReceipt(user, id)); } catch (e) { return failFrom(e, "batches"); }
}
