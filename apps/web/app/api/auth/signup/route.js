import { NextResponse } from "next/server";
import { getSupabaseAuthClient } from "@/lib/supabase/auth-server";
import { parseAuthBody, wantsRedirect } from "@/lib/auth/parse-body";
import { appUrl } from "@/lib/auth/app-url";
import { COLUMNS, validateProfile, saveSignupProfile } from "@profullstack/profile";
import { userProfileStore } from "@/lib/data/user-profile";

export const dynamic = "force-dynamic";

export async function POST(request) {
    const body = await parseAuthBody(request);
    const { email, password } = body;
    const wantHtml = wantsRedirect(request);

    if (!email || !password) {
        if (wantHtml) {
            return NextResponse.redirect(
                new URL(`/auth/signup?error=${encodeURIComponent("email and password required")}`, appUrl()),
                { status: 303 }
            );
        }
        return NextResponse.json({ error: "email and password required" }, { status: 400 });
    }

    // The shared @profullstack/profile fields: first and last name required,
    // company domain, job title and LinkedIn optional.
    const profileInput = Object.fromEntries(COLUMNS.map((c) => [c, body[c]]));
    profileInput.email = email;
    const check = validateProfile(profileInput);
    if (!check.ok) {
        const message = Object.values(check.errors)[0] ?? "Some fields need fixing";
        if (wantHtml) {
            return NextResponse.redirect(
                new URL(`/auth/signup?error=${encodeURIComponent(message)}`, appUrl()),
                { status: 303 }
            );
        }
        return NextResponse.json({ error: message, errors: check.errors }, { status: 400 });
    }

    const supabase = await getSupabaseAuthClient();
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            emailRedirectTo: `${appUrl()}/api/auth/callback?next=/dashboard`,
            data: {
                first_name: check.profile.first_name ?? null,
                last_name: check.profile.last_name ?? null,
                company_domain: check.profile.company_domain ?? null,
                job_title: check.profile.job_title ?? null,
                linkedin_url: check.profile.linkedin_url ?? null
            }
        }
    });

    if (error) {
        if (wantHtml) {
            return NextResponse.redirect(
                new URL(`/auth/signup?error=${encodeURIComponent(error.message)}`, appUrl()),
                { status: 303 }
            );
        }
        return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // A stand-in user with no identities means the address was already
    // registered: never write over that account's profile.
    const user = data?.user;
    if (user?.id && (user.identities?.length ?? 0) > 0) {
        try {
            await saveSignupProfile(userProfileStore(), user.id, profileInput, { email: user.email ?? email });
        } catch (err) {
            // The account exists; the fields can be filled in from /settings.
            console.error("[signup] profile save failed", err);
        }
    }

    if (wantHtml) {
        return NextResponse.redirect(new URL("/auth/check-email?reason=signup", appUrl()), { status: 303 });
    }
    return NextResponse.json({ ok: true, message: "Confirmation email sent. Check your inbox." });
}
