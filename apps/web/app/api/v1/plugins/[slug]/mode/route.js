import { ok } from "@/lib/reservations/http";
import { setTradingMode } from "@/lib/plugins/store";
import { signedIn, failFrom } from "../../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/plugins/<slug>/mode { mode: "paper" | "live", confirm? }: which
 * account a brokerage plugin's orders go to. New connections start on paper;
 * live has to be asked for by name (confirm: true), and every order still
 * needs its own approval in the chat.
 */
export async function POST(request, { params }) {
    const { user, error } = await signedIn(request);
    if (error) return error;
    const { slug } = await params;
    let body = {};
    try { body = (await request.json()) ?? {}; } catch { /* empty */ }
    if (body.mode === "live" && body.confirm !== true) {
        return failFrom(Object.assign(new Error('Switching to live trading needs {"mode":"live","confirm":true}: orders then use real money (each one still asks first).'), { status: 400 }));
    }
    try {
        return ok(await setTradingMode(user, slug, body.mode));
    } catch (e) {
        return failFrom(e);
    }
}
