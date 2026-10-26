import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getSupabaseAuthClient } from "@/lib/supabase/auth-server";
import { appUrl } from "@/lib/auth/app-url";
import { afterSignIn } from "@/lib/credits/sign-in";
import { INVITE_COOKIE } from "@/lib/credits/core";

export const dynamic = "force-dynamic";

/**
 * Email confirmation + magic-link landing.
 *
 * Supabase's redirect URL after a magic-link click looks like:
 *   /api/auth/callback?code=<pkce>&next=/dashboard
 *
 * We exchange the PKCE code for a session (Supabase sets the session
 * cookie via @supabase/ssr) and redirect to `next`.
 */
export async function GET(request) {
    // Parse inbound query (code, next) from the request itself; build
    // outbound redirects against appUrl() so we don't leak proxy hosts.
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const next = url.searchParams.get("next") || "/dashboard";

    if (!code) {
        return NextResponse.redirect(
            new URL(`/auth/login?error=${encodeURIComponent("missing code")}`, appUrl())
        );
    }

    const supabase = await getSupabaseAuthClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
        return NextResponse.redirect(
            new URL(`/auth/login?error=${encodeURIComponent(error.message)}`, appUrl())
        );
    }

    // Bust the layout's Router Cache so SiteHeader picks up the new
    // session cookie without a hard reload.
    revalidatePath("/", "layout");

    // Accept a pending invite (cookie or the code saved at signup), record a
    // ?ref= attribution and settle any invite bonus. Never blocks sign-in.
    await afterSignIn(request, data?.user);

    const res = NextResponse.redirect(new URL(next, appUrl()));
    res.cookies.delete(INVITE_COOKIE);
    return res;
}
