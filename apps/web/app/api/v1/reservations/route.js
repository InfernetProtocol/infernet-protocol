import { validateReservationInput } from "@/lib/reservations/core";
import { createReservation, listReservations, publicReservation } from "@/lib/data/reservations";
import { requireAdmin, fail, ok, guard } from "@/lib/reservations/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Managed endpoints / reservations (docs/prd/16-managed-endpoints.md).
 *
 *   GET  /api/v1/reservations          list (admin)
 *   POST /api/v1/reservations          create (admin) -> { reservation, buyer_token }
 *
 * The buyer token is returned once; hand it to the buyer so they can read
 * the compliance report and invoice view themselves.
 */
export async function GET(request) {
    const auth = requireAdmin(request);
    if (auth.error) return auth.error;
    return guard(async () => ok((await listReservations()).map((r) => publicReservation(r))));
}

export async function POST(request) {
    const auth = requireAdmin(request);
    if (auth.error) return auth.error;
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
    const v = validateReservationInput(body);
    if (!v.ok) return fail(400, "invalid reservation", { details: v.errors });
    return guard(async () => {
        const { reservation, buyerToken } = await createReservation(v.value, { createdBy: auth.actor });
        return ok({ reservation: publicReservation(reservation), buyer_token: buyerToken }, 201);
    });
}
