import AdminPayouts from "@/components/admin-payouts";

export const metadata = {
    title: "Payout approvals",
    robots: { index: false, follow: false }
};
export const dynamic = "force-dynamic";

/**
 * Admin queue for provider withdrawals. Nothing here renders data on the
 * server: the browser holds the admin token and calls /api/v1/admin/*.
 */
export default function AdminPayoutsPage() {
    return (
        <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-10">
            <header className="mb-8">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Admin</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Payout approvals</h1>
                <p className="mt-2 text-sm text-[var(--muted)]">
                    Provider withdrawal requests wait here. Approve sends real funds through CoinPay from the business wallet.
                </p>
            </header>
            <AdminPayouts />
        </main>
    );
}
