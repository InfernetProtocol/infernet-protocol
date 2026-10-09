import { getReservation, updateReservation, publicReservation } from "@/lib/data/reservations";
import { requireAdmin, loadForReader, fail, ok, guard } from "@/lib/reservations/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 *   GET   /api/v1/reservations/:id     admin or buyer (buyer token)
 *   PATCH /api/v1/reservations/:id     admin: name, buyer, notes, price_per_hour,
 *                                      currency, status ("cancelled")
 *
 * The window, target and models are fixed once created; book a new
 * reservation to change them.
 */
export async function GET(request, { params }) {
    const { id } = await params;
    return guard(async () => {
        const r = await loadForReader(request, id);
        if (r.error) return r.error;
        return ok(publicReservation(r.res));
    });
}

export async function PATCH(request, { params }) {
    const auth = requireAdmin(request);
    if (auth.error) return auth.error;
    const { id } = await params;
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON body"); }
    return guard(async () => {
        if (!(await getReservation(id))) return fail(404, "reservation not found");
        return ok(publicReservation(await updateReservation(id, body)));
    });
}
