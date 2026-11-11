import { ok } from "@/lib/reservations/http";
import { removePlugin } from "@/lib/plugins/store";
import { signedIn, failFrom } from "../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/v1/plugins/<slug>: remove a plugin and its tokens. */
export async function DELETE(request, { params }) {
    const { user, error } = await signedIn(request);
    if (error) return error;
    const { slug } = await params;
    try {
        return ok(await removePlugin(user, slug));
    } catch (e) {
        return failFrom(e);
    }
}
