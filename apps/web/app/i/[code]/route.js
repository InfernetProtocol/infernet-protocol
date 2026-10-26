import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { INVITE_COOKIE, INVITE_TTL_DAYS, publicOrigin, looksLikeCode } from "@/lib/credits/core";

export const dynamic = "force-dynamic";

/**
 * GET /i/<code> — invite landing. Keeps the code in a cookie (30 days) and
 * sends a new visitor to signup, where it is also stored on the account
 * (user_metadata) so the confirmation link counts from any browser or phone.
 * A signed-in visitor lands on /invites with a one-click accept.
 *
 * Exempt from the crawl gateway (lib/crawl-gateway.js) so a shared invite
 * link never meets a paywall.
 */
export async function GET(request, { params }) {
    const { code: raw } = await params;
    const origin = publicOrigin(request);
    let code = "";
    try {
        code = decodeURIComponent(String(raw ?? "")).trim();
    } catch {
        code = "";
    }
    if (!looksLikeCode(code)) return NextResponse.redirect(new URL("/auth/signup", origin), 303);

    let user = null;
    try {
        user = await getCurrentUser();
    } catch {
        /* anonymous */
    }
    const dest = user
        ? `/invites?${new URLSearchParams({ accept: code })}`
        : `/auth/signup?${new URLSearchParams({ invite: code })}`;
    const res = NextResponse.redirect(new URL(dest, origin), 303);
    res.cookies.set(INVITE_COOKIE, code, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: INVITE_TTL_DAYS * 24 * 60 * 60
    });
    return res;
}
