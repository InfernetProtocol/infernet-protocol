import { requireCaller, failFrom } from "@/lib/billing/http";
import { batchResults } from "@/lib/data/batches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/batches/:id/results  JSONL: { custom_id, status, output, estimated_tokens, cost_usd, error } per line. */
export async function GET(request, { params }) {
    const { user, error } = await requireCaller(request);
    if (error) return error;
    const { id } = await params;
    try {
        const { jsonl, batch } = await batchResults(user, id);
        return new Response(jsonl, {
            headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-batch-status": batch.status }
        });
    } catch (e) {
        return failFrom(e, "batches");
    }
}
