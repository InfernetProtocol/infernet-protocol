import { ok } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { cancelBatch } from "@/lib/data/batches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/batches/:id/cancel  stop dispatching; queued items' holds are released, running ones settle normally. */
export async function POST(request, { params }) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    const { id } = await params;
    try { return ok(await cancelBatch(user, id)); } catch (e) { return failFrom(e, "batches"); }
}
