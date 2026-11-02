import { ok } from "@/lib/reservations/http";
import { requireSignedIn, failFrom } from "@/lib/billing/http";
import { revokeApiKey } from "@/lib/data/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/v1/keys/:id  revoke one of your keys. */
export async function DELETE(request, { params }) {
    const { user, error } = await requireSignedIn(request);
    if (error) return error;
    const { id } = await params;
    try { return ok(await revokeApiKey(user, id)); } catch (e) { return failFrom(e, "keys"); }
}
