import Link from "next/link";
import AuthFormShell, { AuthInput, AuthButton } from "@/components/auth-form-shell";
import SignupProfileFields from "@/components/signup-profile-fields";
import CoinpaySigninButton from "@/components/coinpay-signin-button";
import { cookies } from "next/headers";
import { INVITE_COOKIE, looksLikeCode, inviteBonusCredits } from "@/lib/credits/core";

export const metadata = { title: "Create an account" };

export default async function SignupPage({ searchParams }) {
    const params = (await searchParams) ?? {};
    const error = typeof params.error === "string" ? params.error : null;
    // An invite from /i/<code> (query) or its cookie rides along with the signup,
    // so the confirmation link accepts it from any browser.
    const fromQuery = typeof params.invite === "string" ? params.invite : null;
    const fromCookie = (await cookies()).get(INVITE_COOKIE)?.value ?? null;
    const invite = [fromQuery, fromCookie].find((c) => looksLikeCode(c)) ?? null;
    const bonus = inviteBonusCredits();

    return (
        <AuthFormShell
            title="Create an account"
            subtitle="We'll email you a confirmation link. No credit card, no token to hold."
            error={error}
            footer={
                <>
                    Already have an account?{" "}
                    <Link href="/auth/login" className="text-[var(--accent)] hover:underline">
                        Sign in
                    </Link>
                </>
            }
        >
            {invite ? (
                <div className="mb-4 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 p-3 text-sm text-white">
                    You were invited. Confirm your email and you both get {bonus} compute credits.
                </div>
            ) : null}
            <CoinpaySigninButton label="Sign up with CoinPay" />
            <form action="/api/auth/signup" method="post" className="space-y-4">
                {invite ? <input type="hidden" name="invite_code" value={invite} /> : null}
                <AuthInput name="email" type="email" label="Email" required autoComplete="email" />
                <SignupProfileFields />
                <AuthInput name="password" type="password" label="Password (8+ characters)" required autoComplete="new-password" />
                <AuthButton>Create account</AuthButton>
            </form>
        </AuthFormShell>
    );
}
