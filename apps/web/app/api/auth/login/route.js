import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getSupabaseAuthClient } from "@/lib/supabase/auth-server";
import { parseAuthBody, wantsRedirect } from "@/lib/auth/parse-body";
import { appUrl } from "@/lib/auth/app-url";
import { afterSignIn } from "@/lib/credits/sign-in";

export const dynamic = "force-dynamic";

/**
 * Two flows behind one endpoint:
 *   - email + password → sign in directly
 *   - email only       → send a magic link (use case: passwordless)
 */
export async function POST(request) {
    const body = await parseAuthBody(request);
    const wantHtml = wantsRedirect(request);
    const email = String(body.email ?? "").trim();
    const password = body.password ? String(body.password) : null;

    if (!email) {
        return wantHtml
            ? NextResponse.redirect(
                new URL(`/auth/login?error=${encodeURIComponent("email required")}`, appUrl()),
                { status: 303 }
            )
            : NextResponse.json({ error: "email required" }, { status: 400 });
    }

    const supabase = await getSupabaseAuthClient();

    if (password) {
        const { data: signedIn, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            return wantHtml
                ? NextResponse.redirect(
                    new URL(`/auth/login?error=${encodeURIComponent(error.message)}`, appUrl()),
                    { status: 303 }
                )
                : NextResponse.json({ error: error.message }, { status: 401 });
        }
        // Bust the layout's Router Cache so SiteHeader picks up the new
        // session cookie without a hard reload — same trap as logout.
        revalidatePath("/", "layout");
        await afterSignIn(request, signedIn?.user);
        return wantHtml
            ? NextResponse.redirect(new URL("/dashboard", appUrl()), { status: 303 })
            : NextResponse.json({ ok: true });
    }

    // Magic link path
    const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${appUrl()}/api/auth/callback?next=/dashboard` }
    });
    if (error) {
        return wantHtml
            ? NextResponse.redirect(
                new URL(`/auth/login?error=${encodeURIComponent(error.message)}`, appUrl()),
                { status: 303 }
            )
            : NextResponse.json({ error: error.message }, { status: 400 });
    }

    return wantHtml
        ? NextResponse.redirect(new URL("/auth/check-email?reason=magic-link", appUrl()), { status: 303 })
        : NextResponse.json({ ok: true, message: "Magic link sent." });
}
