import { NextResponse } from "next/server";
import { requestUser, isFormPost, readBody } from "@/lib/auth/request-user";
import { redeemCreditCode } from "@/lib/credits";
import { publicOrigin } from "@/lib/credits/core";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Codes are 80 random bits, so guessing is hopeless; this only stops floods.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });

/**
 * POST /api/v1/credits/redeem  { code }   (JSON, or the "Have a code?" form on /settings)
 * Auth: CLI bearer or the session cookie.
 * → { ok: true, credits, monthly, balance } | 400 { error, reason }
 *   reason: invalid | expired | used_up | already_redeemed | revoked
 */
export async function POST(request) {
    const form = isFormPost(request);
    const back = (params) =>
        NextResponse.redirect(new URL(`/settings?${new URLSearchParams(params)}#credits`, publicOrigin(request)), 303);

    const user = await requestUser(request);
    if (!user) {
        return form
            ? NextResponse.redirect(new URL("/auth/login?next=/settings", publicOrigin(request)), 303)
            : NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    const gate = limit.check(`${user.id}:${getClientIp(request)}`);
    if (!gate.ok) {
        return form
            ? back({ credit_error: "Too many attempts. Try again later." })
            : NextResponse.json({ error: "too many attempts" }, { status: 429 });
    }

    const body = await readBody(request);
    const code = String(body.code ?? "").trim();
    let r;
    try {
        r = await redeemCreditCode(user.id, code);
    } catch (err) {
        console.error("[credits] redeem failed", err?.message ?? err);
        return form
            ? back({ credit_error: "Could not redeem right now. Try again." })
            : NextResponse.json({ error: "redeem failed" }, { status: 503 });
    }
    if (!r.ok) {
        return form ? back({ credit_error: r.message }) : NextResponse.json({ error: r.message, reason: r.reason }, { status: 400 });
    }
    return form
        ? back({ credit_ok: String(r.credits), ...(r.monthly ? { monthly: "1" } : {}) })
        : NextResponse.json({ ok: true, credits: r.credits, monthly: r.monthly, balance: r.balance });
}
