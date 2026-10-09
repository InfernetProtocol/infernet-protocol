import { reportFor } from "@/lib/data/reservations";
import { loadForReader, ok, guard } from "@/lib/reservations/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/reservations/:id/report[?minutes=1]
 *
 * Per-hour availability + usage. Readable by an admin or by the buyer with
 * the reservation's buyer token (X-Buyer-Token header or ?token=).
 * ?minutes=1 adds every per-minute probe record so the buyer can check the
 * hour verdicts themselves.
 */
export async function GET(request, { params }) {
    const { id } = await params;
    return guard(async () => {
        const r = await loadForReader(request, id);
        if (r.error) return r.error;
        const { report, probes } = await reportFor(r.res);
        const withMinutes = new URL(request.url).searchParams.get("minutes") === "1";
        return ok(withMinutes ? { ...report, probes } : report);
    });
}
