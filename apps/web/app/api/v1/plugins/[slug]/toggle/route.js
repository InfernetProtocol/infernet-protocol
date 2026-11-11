import { ok } from "@/lib/reservations/http";
import { togglePlugin } from "@/lib/plugins/store";
import { signedIn, failFrom } from "../../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/plugins/<slug>/toggle { enabled? }: turn a plugin on or off (flips when omitted). */
export async function POST(request, { params }) {
    const { user, error } = await signedIn(request);
    if (error) return error;
    const { slug } = await params;
    let body = {};
    try { body = (await request.json()) ?? {}; } catch { /* flip */ }
    try {
        return ok(await togglePlugin(user, slug, typeof body.enabled === "boolean" ? body.enabled : undefined));
    } catch (e) {
        return failFrom(e);
    }
}
