import { NextResponse } from "next/server";
import { requestUser, isFormPost, readBody, cookieFrom } from "@/lib/auth/request-user";
import { acceptInvite } from "@/lib/credits";
import { INVITE_COOKIE, publicOrigin } from "@/lib/credits/core";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/invites/accept  { code }  — a signed-in NEW account joins on an invite.
 * (New sign-ups do not need this: /i/<code> + signup or the confirmation link accept it.)
 * → { ok: true, bonus: granted|pending|denied, bonusCredits } | 400 { error, reason }
 */
export async function POST(request) {
    const form = isFormPost(request);
    const origin = publicOrigin(request);
    const user = await requestUser(request);
    if (!user) {
        return form
            ? NextResponse.redirect(new URL("/auth/signup", origin), 303)
            : NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    const body = await readBody(request);
    const code = String(body.code ?? cookieFrom(request, INVITE_COOKIE) ?? "").trim();
    let r;
    try {
        r = await acceptInvite(user.id, code);
    } catch (err) {
        console.error("[invites] accept failed", err?.message ?? err);
        r = { ok: false, reason: "error", message: "Could not accept the invite right now." };
    }
    if (form) {
        const params = r.ok ? { joined: r.bonus } : { error: r.message };
        const res = NextResponse.redirect(new URL(`/invites?${new URLSearchParams(params)}`, origin), 303);
        res.cookies.delete(INVITE_COOKIE);
        return res;
    }
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.message, reason: r.reason }, { status: 400 });
}
