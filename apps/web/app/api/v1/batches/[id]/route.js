import { ok } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { batchView } from "@/lib/data/batches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/batches/:id  status, counts, cost so far, funding, items (outputs once finished). */
export async function GET(request, { params }) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    const { id } = await params;
    try { return ok(await batchView(user, id)); } catch (e) { return failFrom(e, "batches"); }
}
