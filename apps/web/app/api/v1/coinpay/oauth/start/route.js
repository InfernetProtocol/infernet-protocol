import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { isSameOriginRequest } from "@/lib/auth/admin";
import { readBody } from "@/lib/auth/request-user";
import {
    OAUTH_COOKIE,
    OAUTH_COOKIE_MAX_AGE,
    OAUTH_COOKIE_PATH,
    beginCoinpay,
    coinpayConfig,
} from "@/lib/auth/coinpay-signin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function go(cfg, url, cookie, status) {
    const res = NextResponse.redirect(url, status);
    res.cookies.set(OAUTH_COOKIE, cookie, {
        httpOnly: true,
        secure: cfg.siteUrl.startsWith("https:"),
        sameSite: "lax",
        path: OAUTH_COOKIE_PATH,
        maxAge: OAUTH_COOKIE_MAX_AGE,
    });
    res.headers.set("cache-control", "no-store");
    return res;
}

/** GET /api/v1/coinpay/oauth/start?next=/dashboard : "Sign in with CoinPay". */
export async function GET(request) {
    const cfg = coinpayConfig();
    if (!cfg) return new NextResponse("Sign in with CoinPay is not configured.", { status: 503 });
    const next = new URL(request.url).searchParams.get("next");
    const { url, cookie } = beginCoinpay(cfg, { mode: "login", next });
    return go(cfg, url, cookie, 302);
}

/**
 * POST /api/v1/coinpay/oauth/start (form: mode=connect) : "Connect CoinPay"
 * from Settings. Needs the signed-in session and a same-origin form, so no
 * other site can start a link for someone.
 */
export async function POST(request) {
    const cfg = coinpayConfig();
    if (!cfg) return new NextResponse("Sign in with CoinPay is not configured.", { status: 503 });
    if (!isSameOriginRequest(request.headers)) return new NextResponse("Cross-site request refused.", { status: 403 });
    const user = await getCurrentUser();
    if (!user) return NextResponse.redirect(new URL("/auth/login?next=/settings", cfg.siteUrl), 303);
    const body = await readBody(request);
    const { url, cookie } = beginCoinpay(cfg, { mode: "connect", next: body.next ?? "/settings", userId: user.id });
    return go(cfg, url, cookie, 303);
}
