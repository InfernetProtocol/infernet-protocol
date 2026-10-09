import { invoiceFor } from "@/lib/data/reservations";
import { loadForReader, ok, guard } from "@/lib/reservations/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/reservations/:id/invoice
 *
 * Post-paid invoice data: each reserved hour, its compliance status, and the
 * amount due — compliant hours x price_per_hour, nothing for the rest. No
 * payment is requested or executed. `final` is false while hours are open.
 */
export async function GET(request, { params }) {
    const { id } = await params;
    return guard(async () => {
        const r = await loadForReader(request, id);
        if (r.error) return r.error;
        return ok(await invoiceFor(r.res));
    });
}
