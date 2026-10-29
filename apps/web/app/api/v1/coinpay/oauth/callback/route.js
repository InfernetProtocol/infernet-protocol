import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { finishSignIn, sameState } from "@profullstack/coinpay-onboard/oauth";
import { getSupabaseAuthClient } from "@/lib/supabase/auth-server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { afterSignIn } from "@/lib/credits/sign-in";
import { INVITE_COOKIE } from "@/lib/credits/core";
import {
    OAUTH_COOKIE,
    OAUTH_COOKIE_PATH,
    coinpayConfig,
    mintMagicLinkHash,
    openPending,
    resolveCoinpayUser,
    supabaseCoinpayStore,
} from "@/lib/auth/coinpay-signin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/coinpay/oauth/callback?code&state
 * Checks state (signed cookie) and the id_token (iss/aud/exp/nonce, userinfo
 * sub), resolves the Infernet user BY CoinPay sub (lib/auth/coinpay-signin.js),
 * then either links (mode=connect, signed in as the user who started it) or
 * signs in by redeeming a server-minted magic-link hash for that user's own
 * auth email.
 */
export async function GET(request) {
    const cfg = coinpayConfig();
    if (!cfg) return new NextResponse("Sign in with CoinPay is not configured.", { status: 503 });
    const sp = new URL(request.url).searchParams;
    const pending = openPending(request.cookies.get(OAUTH_COOKIE)?.value, cfg.clientSecret);
    const back = (path, error) => {
        const url = new URL(path, cfg.siteUrl);
        if (error) url.searchParams.set("error", error);
        const res = NextResponse.redirect(url, 302);
        res.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
        res.headers.set("cache-control", "no-store");
        return res;
    };
    const failPath = pending?.mode === "connect" ? "/settings" : "/auth/login";

    if (!pending) return back("/auth/login", "CoinPay sign-in expired. Try again.");
    if (!sameState(pending.state, sp.get("state"))) return back(failPath, "CoinPay sign-in failed: state mismatch.");
    if (sp.get("error")) return back(failPath, "CoinPay sign-in was cancelled.");
    const code = sp.get("code");
    if (!code) return back(failPath, "CoinPay sign-in failed: no code.");

    let claims;
    try {
        const r = await finishSignIn({
            code,
            verifier: pending.verifier,
            nonce: pending.nonce,
            clientId: cfg.clientId,
            clientSecret: cfg.clientSecret,
            redirectUri: cfg.redirectUri,
            base: cfg.issuer,
        });
        claims = { sub: r.sub, email: r.email ? r.email.slice(0, 320) : null, name: r.name ? r.name.slice(0, 200) : null };
    } catch (e) {
        console.error("[coinpay-signin] token/userinfo", e instanceof Error ? e.message : e);
        return back(failPath, "CoinPay sign-in failed. Try again.");
    }

    const supabase = await getSupabaseAuthClient();
    const { data: cur } = await supabase.auth.getUser();
    const currentUserId = cur?.user?.id ?? null;
    // Connect binds to the account that started it, still signed in here.
    if (pending.mode === "connect" && (!currentUserId || currentUserId !== pending.userId)) {
        return back("/auth/login?next=/settings", "Sign in again, then connect CoinPay from Settings.");
    }
    const sb = getSupabaseServerClient();
    let resolved;
    try {
        resolved = await resolveCoinpayUser({ mode: pending.mode, currentUserId, claims }, supabaseCoinpayStore(sb));
    } catch (e) {
        console.error("[coinpay-signin] resolve", e instanceof Error ? e.message : e);
        return back(failPath, "CoinPay sign-in failed. Try again.");
    }
    if (!resolved.ok) return back(failPath, resolved.error);
    if (pending.mode === "connect") {
        return back(`${pending.next}${pending.next.includes("?") ? "&" : "?"}coinpay=connected`);
    }

    if (currentUserId !== resolved.userId) {
        if (currentUserId) await supabase.auth.signOut({ scope: "local" }).catch(() => {});
        const minted = await mintMagicLinkHash(sb, resolved.userId);
        if (!minted.ok) return back("/auth/login", minted.error);
        const { data: signedIn, error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: minted.tokenHash });
        if (error) {
            console.error("[coinpay-signin] verifyOtp", error.message);
            return back("/auth/login", "Could not start your session. Try again.");
        }
        await afterSignIn(request, signedIn?.user);
    }
    revalidatePath("/", "layout");
    const res = back(pending.next);
    res.cookies.delete(INVITE_COOKIE);
    return res;
}
