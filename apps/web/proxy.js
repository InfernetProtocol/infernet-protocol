import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { gate } from "@/lib/crawl-gateway";

/**
 * Refreshes the Supabase auth session cookie on every request.
 *
 * Required by `@supabase/ssr` — without this, sessions silently
 * expire and Server Components see logged-out state even when the
 * user just authenticated. The pattern is straight from the official
 * Supabase Next.js docs.
 *
 * Skips static assets, the health probe, and a couple of public
 * non-auth API routes that don't need session context.
 */
export async function proxy(request) {
    // Canonical host: redirect www.infernetprotocol.com → infernetprotocol.com
    // (and any other www.* host we end up answering for) with a 308 so
    // the method + body survive. We build the target URL from scratch
    // because `new URL(request.url)` inherits the container's internal
    // port (e.g. :8080), which would leak into the Location header and
    // make the redirect unreachable from the public Internet.
    const host = (request.headers.get("host") ?? "").split(":")[0];
    if (host.startsWith("www.")) {
        const apexHost = host.slice(4);
        const path = request.nextUrl.pathname || "/";
        const search = request.nextUrl.search || "";
        return NextResponse.redirect(`https://${apexHost}${path}${search}`, 308);
    }

    // Crawl gateway: AI training crawlers get 402 Payment Required (or the
    // pass page at /crawl) unless they present a paid pass. People, Googlebot
    // and AI chat fetchers fall through to everything below.
    const answer = await gate(request);
    if (answer) return answer;

    const response = NextResponse.next({ request });

    // Hiring beacon — anyone running `curl -I https://infernetprotocol.com/`
    // (or hitting any of our API endpoints) sees this header and can
    // click through. Cheap discovery channel for the operators / devs
    // already poking at our surface area.
    response.headers.set("X-Hiring", "https://infernetprotocol.com/careers");

    // Affiliate links (?ref=<code>): keep the FIRST touch for 30 days in the
    // referral_code cookie (@profullstack/referrals' name, read by
    // @profullstack/affiliates' refFromRequest at signup / sign-in).
    const ref = request.nextUrl.searchParams.get("ref");
    if (ref && /^[A-Za-z0-9_-]{4,64}$/.test(ref) && !request.cookies.get("referral_code")) {
        response.cookies.set("referral_code", ref, {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
            maxAge: 30 * 24 * 60 * 60
        });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    // If Supabase isn't configured (e.g. local dev without an .env), skip
    // session refresh entirely — pages still render, anonymous users are
    // simply anonymous.
    if (!url || !anonKey) return response;

    const supabase = createServerClient(url, anonKey, {
        cookies: {
            getAll() {
                return request.cookies.getAll();
            },
            setAll(cookiesToSet) {
                for (const { name, value } of cookiesToSet) {
                    request.cookies.set(name, value);
                }
                for (const { name, value, options } of cookiesToSet) {
                    response.cookies.set(name, value, options);
                }
            }
        }
    });

    // Touching getUser() forces session refresh + cookie rotation.
    await supabase.auth.getUser();
    return response;
}

export const config = {
    matcher: [
        // Run on everything EXCEPT static assets and the health probe.
        "/((?!_next/static|_next/image|favicon.ico|install\\.sh|.well-known|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"
    ]
};
