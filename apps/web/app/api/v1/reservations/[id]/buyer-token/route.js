import { getReservation, rotateBuyerToken } from "@/lib/data/reservations";
import { requireAdmin, fail, ok, guard } from "@/lib/reservations/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/reservations/:id/buyer-token — issue a new buyer token; the old one stops working. */
export async function POST(request, { params }) {
    const auth = requireAdmin(request);
    if (auth.error) return auth.error;
    const { id } = await params;
    return guard(async () => {
        if (!(await getReservation(id))) return fail(404, "reservation not found");
        return ok({ buyer_token: await rotateBuyerToken(id) });
    });
}
