import { NextResponse } from "next/server";
import { requestUser } from "@/lib/auth/request-user";
import { readTicket, startConnect } from "@/lib/plugins/store";
import { pluginResultPage, STATE_COOKIE } from "../../result-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/plugins/<slug>/connect[?t=<ticket>][&return=/chat]
 * Sends the browser to the plugin's own sign-in page. Works from the site
 * (session cookie) or from a one-time link the CLI / MCP printed (?t=), so a
 * terminal user can finish in any browser.
 */
export async function GET(request, { params }) {
    const { slug } = await params;
    const url = new URL(request.url);
    let userId = null;
    const ticket = url.searchParams.get("t");
    try {
        if (ticket) {
            const t = readTicket(ticket);
            if (t && t.slug === slug) userId = t.userId;
        }
        if (!userId) userId = (await requestUser(request))?.id ?? null;
    } catch (e) {
        return pluginResultPage({ ok: false, message: e?.message ?? "Plugins are unavailable" }, 503);
    }
    if (!userId) {
        return pluginResultPage({ ok: false, message: "This sign-in link expired. Run the add command again, or open /chat and sign in." }, 401);
    }
    try {
        const authorizeUrl = await startConnect(userId, slug, { returnTo: url.searchParams.get("return") ?? undefined });
        const res = NextResponse.redirect(authorizeUrl, 302);
        // The callback only finishes a sign-in this same browser started, so a
        // sign-in link someone else made cannot attach your account to theirs.
        res.cookies.set(STATE_COOKIE, new URL(authorizeUrl).searchParams.get("state") ?? "", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            path: "/api/v1/plugins/callback",
            maxAge: 30 * 60
        });
        return res;
    } catch (e) {
        return pluginResultPage({ ok: false, slug, message: e?.message ?? String(e) }, Number.isInteger(e?.status) ? e.status : 500);
    }
}
