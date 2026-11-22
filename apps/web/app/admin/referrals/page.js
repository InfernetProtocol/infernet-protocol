import Link from "next/link";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { isAdminUser } from "@/lib/auth/admin";
import { getReferralResults } from "@/lib/data/referrals";
import { fmtUsdPrecise } from "@/lib/earnings/core";

export const metadata = {
    title: "Referral experiment",
    robots: { index: false, follow: false }
};
export const dynamic = "force-dynamic";

const ROWS = [
    ["referrers", "Referrers (codes created)", "n"],
    ["referrers_with_nodes", "Referrers with a referred node", "n"],
    ["referred_nodes", "Referred node signups", "n"],
    ["nodes_with_paid_jobs", "Referred nodes with a paid job", "n"],
    ["active_nodes", "Active referred nodes", "n"],
    ["referred_revenue_usd", "Referred-node revenue (gross)", "usd"],
    ["house_fee_usd", "House fee on referred nodes", "usd"],
    ["commissions_accrued_usd", "Commissions accrued", "usd"],
    ["commissions_confirmed_usd", "Commissions confirmed", "usd"],
    ["commissions_paid_usd", "Commissions paid out", "usd"]
];

/**
 * /admin/referrals — the node-referral A/B test on commission term: "12m"
 * (12 months from a referred node's first paid job) vs "lifetime". Arms are
 * drawn 50/50 once per referrer at code creation. Same data as
 * GET /api/v1/admin/referrals.
 */
export default async function AdminReferralsPage({ searchParams }) {
    let user = null;
    try {
        user = await getCurrentUser();
    } catch {
        /* not signed in */
    }
    if (!isAdminUser(user)) {
        return (
            <main className="mx-auto w-full max-w-3xl px-6 py-12">
                <p className="text-sm text-[var(--muted)]">
                    Admins only. <Link className="underline" href="/auth/login?next=/admin/referrals">Sign in</Link> with an admin account, or
                    read <code>GET /api/v1/admin/referrals</code> with INFERNET_ADMIN_TOKEN.
                </p>
            </main>
        );
    }
    const params = (await searchParams) ?? {};
    const days = Number(params.active_days);
    const activeDays = Number.isInteger(days) && days > 0 && days <= 90 ? days : 7;
    let r = null;
    let err = null;
    try {
        r = await getReferralResults({ activeDays });
    } catch (e) {
        err = e?.message ?? String(e);
    }
    return (
        <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 lg:px-10">
            <header className="mb-8">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Admin</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Node referrals: commission term test</h1>
                <p className="mt-2 text-sm text-[var(--muted)]">
                    Each referrer is assigned once, 50/50, when their code is created. Commission ={" "}
                    {r?.config?.commission_pct_of_house_fee ?? 5}% of the house fee (settings row <code>referrals</code>). Active = a paid
                    credit in the last {activeDays} days (<Link className="underline" href="?active_days=30">30</Link>,{" "}
                    <Link className="underline" href="?active_days=7">7</Link>).
                </p>
            </header>
            {err ? <p className="text-sm text-red-300">{err}</p> : null}
            {r ? (
                <table className="w-full text-left text-sm">
                    <thead>
                        <tr className="text-[var(--muted)]">
                            <th className="py-2">Metric</th>
                            {r.arms.map((a) => (
                                <th key={a.arm} className="py-2">{a.arm === "12m" ? "12 months" : "Lifetime"}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {ROWS.map(([key, label, kind]) => (
                            <tr key={key} className="border-t border-white/10">
                                <td className="py-2 text-[var(--muted)]">{label}</td>
                                {r.arms.map((a) => (
                                    <td key={a.arm} className="py-2 font-mono text-white">
                                        {kind === "usd" ? fmtUsdPrecise(a[key]) : a[key]}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
            {r ? (
                <p className="mt-6 text-xs text-[var(--muted)]">
                    Generated {r.generated_at}. {r.totals.codes} codes, {r.totals.attributions} attributions, {r.totals.commissions} commission rows.
                    House fee {r.house_fee_pct}%.
                </p>
            ) : null}
        </main>
    );
}
