import { NextResponse } from "next/server";
import { requestUser, isFormPost, readBody } from "@/lib/auth/request-user";
import { inviteOverview, createInvite, settleInvitesSentBy, InviteError } from "@/lib/credits";
import { publicOrigin, inviteUrl, refUrl, FLASH_COOKIE } from "@/lib/credits/core";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/invites  → { quota, invites, canInvite, unlocksAt, bonusCredits, affiliateCode, refUrl }
 * POST /api/v1/invites  { note? } → 201 { code, url, id, expiresAt }   (the code is shown once)
 * Auth: CLI bearer or the session cookie.
 */
export async function GET(request) {
    const user = await requestUser(request);
    if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    try {
        await settleInvitesSentBy(user.id);
        const o = await inviteOverview(user.id);
        return NextResponse.json(
            { ...o, refUrl: refUrl(publicOrigin(request), o.affiliateCode) },
            { headers: { "cache-control": "no-store" } }
        );
    } catch (err) {
        console.error("[invites] overview failed", err?.message ?? err);
        return NextResponse.json({ error: "invites unavailable" }, { status: 503 });
    }
}

export async function POST(request) {
    const form = isFormPost(request);
    const origin = publicOrigin(request);
    const user = await requestUser(request);
    if (!user) {
        return form
            ? NextResponse.redirect(new URL("/auth/login?next=/invites", origin), 303)
            : NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    const body = await readBody(request);
    try {
        const inv = await createInvite(user.id, String(body.note ?? ""));
        const url = inviteUrl(origin, inv.code);
        if (form) {
            const res = NextResponse.redirect(new URL("/invites?created=1", origin), 303);
            res.cookies.set(FLASH_COOKIE, inv.code, { httpOnly: true, secure: true, sameSite: "lax", path: "/invites", maxAge: 120 });
            return res;
        }
        return NextResponse.json(
            { code: inv.code, url, id: inv.id, expiresAt: inv.expiresAt ? new Date(inv.expiresAt).toISOString() : null },
            { status: 201 }
        );
    } catch (err) {
        const status = err instanceof InviteError ? err.status : 500;
        const message = err instanceof InviteError ? err.message : "Could not create an invite.";
        if (!(err instanceof InviteError)) console.error("[invites] create failed", err?.message ?? err);
        return form
            ? NextResponse.redirect(new URL(`/invites?${new URLSearchParams({ error: message })}`, origin), 303)
            : NextResponse.json({ error: message, ...(err?.reason ? { reason: err.reason } : {}) }, { status });
    }
}
