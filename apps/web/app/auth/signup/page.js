import Link from "next/link";
import AuthFormShell, { AuthInput, AuthButton } from "@/components/auth-form-shell";
import SignupProfileFields from "@/components/signup-profile-fields";

export const metadata = { title: "Create an account" };

export default async function SignupPage({ searchParams }) {
    const params = (await searchParams) ?? {};
    const error = typeof params.error === "string" ? params.error : null;

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
            <form action="/api/auth/signup" method="post" className="space-y-4">
                <AuthInput name="email" type="email" label="Email" required autoComplete="email" />
                <SignupProfileFields />
                <AuthInput name="password" type="password" label="Password (8+ characters)" required autoComplete="new-password" />
                <AuthButton>Create account</AuthButton>
            </form>
        </AuthFormShell>
    );
}
