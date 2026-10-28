import Link from "next/link";
import AdminPayouts from "@/components/admin-payouts";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { isAdminUser } from "@/lib/auth/admin";

export const metadata = {
    title: "Payout approvals",
    robots: { index: false, follow: false }
};
export const dynamic = "force-dynamic";

/**
 * Admin queue for provider withdrawals. Sign in with an admin account
 * (INFERNET_ADMIN_USER_IDS / INFERNET_ADMIN_EMAILS) and the browser calls
 * /api/v1/admin/* with the session cookie; the pasted INFERNET_ADMIN_TOKEN
 * still works as a fallback.
 */
export default async function AdminPayoutsPage() {
    let user = null;
    try {
        user = await getCurrentUser();
    } catch {
        /* auth not configured: token fallback only */
    }
    const admin = isAdminUser(user);
    return (
        <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-10">
            <header className="mb-8">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Admin</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Payout approvals</h1>
                <p className="mt-2 text-sm text-[var(--muted)]">
                    Provider withdrawal requests wait here. Approve sends real funds through CoinPay from the business wallet.
                </p>
                {admin ? (
                    <p className="mt-2 text-xs text-[var(--muted)]">Signed in as {user.email}.</p>
                ) : null}
            </header>
            {admin ? (
                <AdminPayouts session />
            ) : (
                <div className="space-y-6">
                    <div className="max-w-md space-y-3 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                        {user ? (
                            <p className="text-sm text-white">
                                {user.email} is signed in but is not an admin. Sign out and sign in with the admin account.
                            </p>
                        ) : (
                            <p className="text-sm text-white">Sign in with the admin account to approve payouts.</p>
                        )}
                        <Link href="/auth/login?next=/admin/payouts"
                            className="inline-block rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black">
                            Sign in
                        </Link>
                    </div>
                    <details className="text-sm text-[var(--muted)]">
                        <summary className="cursor-pointer">Use the admin token instead</summary>
                        <div className="mt-3"><AdminPayouts /></div>
                    </details>
                </div>
            )}
        </main>
    );
}
