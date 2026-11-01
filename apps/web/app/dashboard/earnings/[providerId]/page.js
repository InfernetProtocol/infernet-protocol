import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getUserProviders } from "@/lib/data/dashboard";
import { getEarningsForProviders } from "@/lib/data/earnings";
import { EARNING_STATUS_LABELS, fmtUsdPrecise } from "@/lib/earnings/core";

export const dynamic = "force-dynamic";
export const metadata = { title: "Earnings details — Infernet" };

const PAGE_SIZE = 50;

export default async function ProviderEarningsPage({ params, searchParams }) {
    const user = await getCurrentUser();
    if (!user) redirect("/auth/login?next=/dashboard");

    const { providerId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(providerId ?? "")) notFound();

    const providers = await getUserProviders(user.id, { includeArchived: true });
    const provider = providers.find((row) => row.id === providerId);
    if (!provider) notFound();

    const query = (await searchParams) ?? {};
    const requestedPage = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const supabase = getSupabaseServerClient();
    const [summary, countResult, payoutResult] = await Promise.all([
        getEarningsForProviders([provider.id], { recent: 0 }),
        supabase
            .from("provider_earnings")
            .select("id", { count: "exact", head: true })
            .eq("provider_id", provider.id),
        supabase
            .from("payout_requests")
            .select("id, amount_usd, coin, network, status, tx_hash, created_at, sent_at")
            .eq("provider_id", provider.id)
            .order("created_at", { ascending: false })
            .limit(1000)
    ]);
    if (countResult.error) throw new Error(countResult.error.message);
    if (payoutResult.error) throw new Error(payoutResult.error.message);

    const count = countResult.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const from = (page - 1) * PAGE_SIZE;
    const { data: entries, error: entriesError } = await supabase
        .from("provider_earnings")
        .select("id, job_id, kind, role, output_tokens, rate_per_1k_usd, gross_usd, fee_usd, amount_usd, status, model_name, earned_at")
        .eq("provider_id", provider.id)
        .order("earned_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
    if (entriesError) throw new Error(entriesError.message);

    const jobIds = [...new Set((entries ?? []).map((entry) => entry.job_id).filter(Boolean))];
    let jobs = [];
    if (jobIds.length > 0) {
        const { data, error } = await supabase
            .from("jobs")
            .select("id, title, model_name, type")
            .in("id", jobIds);
        if (error) throw new Error(error.message);
        jobs = data ?? [];
    }

    const jobById = new Map(jobs.map((job) => [job.id, job]));
    const balance = summary.per_provider?.[provider.id] ?? {};
    const earnedTotal = Number(balance.confirmed_usd ?? 0)
        + Number(balance.pending_usd ?? 0)
        + Number(balance.pending_approval_usd ?? 0);

    return (
        <main className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-10">
            <p className="mb-5 text-sm text-[var(--muted)]">
                <Link href="/dashboard#earnings" className="text-[var(--accent)] hover:underline">← Earnings and payouts</Link>
            </p>
            <header className="mb-8">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Provider earnings</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">{provider.name}</h1>
                <p className="mt-2 text-sm text-[var(--muted)]">
                    {provider.archived_at ? "Archived node · " : ""}{provider.node_id ?? "Provider node"} · {count} ledger entries
                </p>
            </header>

            <section aria-label="Earnings summary" className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-7">
                <SummaryCard label="Earned" value={fmtUsdPrecise(earnedTotal)} />
                <SummaryCard label="Confirmed" value={fmtUsdPrecise(balance.confirmed_usd)} />
                <SummaryCard label="Pending" value={fmtUsdPrecise(balance.pending_usd)} />
                <SummaryCard label="Pending approval" value={fmtUsdPrecise(balance.pending_approval_usd)} />
                <SummaryCard label="Payout in progress" value={fmtUsdPrecise(balance.requested_usd)} />
                <SummaryCard label="Paid out" value={fmtUsdPrecise(balance.paid_usd)} />
                <SummaryCard label="Available to withdraw" value={fmtUsdPrecise(balance.available_usd)} />
            </section>

            <section className="mb-10 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-5 sm:p-6">
                <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
                    <div>
                        <h2 className="text-lg font-semibold text-white">What earned credits</h2>
                        <p className="mt-1 text-sm text-[var(--muted)]">Per-job credits, token counts, house fees, and payment status.</p>
                    </div>
                    <p className="text-xs text-[var(--muted)]">Page {page} of {totalPages}</p>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-sm">
                        <thead className="text-xs uppercase tracking-[0.15em] text-[var(--muted)]">
                            <tr>
                                <th className="py-2 pr-4 font-medium">When</th>
                                <th className="py-2 pr-4 font-medium">Job / model</th>
                                <th className="py-2 pr-4 font-medium">Work</th>
                                <th className="py-2 pr-4 text-right font-medium">Output tokens</th>
                                <th className="py-2 pr-4 text-right font-medium">Gross</th>
                                <th className="py-2 pr-4 text-right font-medium">House fee</th>
                                <th className="py-2 pr-4 text-right font-medium">Earned</th>
                                <th className="py-2 font-medium">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(entries ?? []).map((entry) => {
                                const job = jobById.get(entry.job_id);
                                const model = entry.model_name ?? job?.model_name;
                                return (
                                    <tr key={entry.id} className="border-t border-white/5 text-white/90">
                                        <td className="whitespace-nowrap py-3 pr-4 text-[var(--muted)]">{formatDate(entry.earned_at)}</td>
                                        <td className="max-w-72 py-3 pr-4">
                                            <span className="block truncate">{job?.title || `Job ${entry.job_id.slice(0, 8)}`}</span>
                                            <span className="block truncate text-xs text-[var(--muted)]">{model || "Model not recorded"}</span>
                                        </td>
                                        <td className="whitespace-nowrap py-3 pr-4">
                                            {entry.kind === "subsidy" ? "Playground subsidy" : "Paid inference"}
                                            {entry.role && entry.role !== "single" ? <span className="block text-xs text-[var(--muted)]">{entry.role}</span> : null}
                                            {entry.rate_per_1k_usd != null ? <span className="block text-xs text-[var(--muted)]">{fmtUsdPrecise(entry.rate_per_1k_usd)} / 1K tokens</span> : null}
                                        </td>
                                        <td className="py-3 pr-4 text-right tabular-nums">{Number(entry.output_tokens ?? 0).toLocaleString("en-US")}</td>
                                        <td className="py-3 pr-4 text-right tabular-nums">{fmtUsdPrecise(entry.gross_usd)}</td>
                                        <td className="py-3 pr-4 text-right tabular-nums">{fmtUsdPrecise(entry.fee_usd)}</td>
                                        <td className="py-3 pr-4 text-right font-medium tabular-nums">{fmtUsdPrecise(entry.amount_usd)}</td>
                                        <td className="whitespace-nowrap py-3 text-xs">{EARNING_STATUS_LABELS[entry.status] ?? entry.status}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                {(entries ?? []).length === 0 ? <p className="py-8 text-center text-sm text-[var(--muted)]">No earnings recorded for this node yet.</p> : null}
                {totalPages > 1 ? (
                    <nav aria-label="Earnings pages" className="mt-4 flex justify-between border-t border-white/5 pt-4 text-sm">
                        {page > 1 ? <Link href={`/dashboard/earnings/${provider.id}?page=${page - 1}`} className="text-[var(--accent)] hover:underline">← Newer entries</Link> : <span />}
                        {page < totalPages ? <Link href={`/dashboard/earnings/${provider.id}?page=${page + 1}`} className="text-[var(--accent)] hover:underline">Older entries →</Link> : null}
                    </nav>
                ) : null}
            </section>

            <section className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-5 sm:p-6">
                <h2 className="text-lg font-semibold text-white">Payout history</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">Withdrawals requested from this node&apos;s earnings.</p>
                {(payoutResult.data ?? []).length === 0 ? (
                    <p className="mt-4 text-sm text-[var(--muted)]">No payouts requested yet.</p>
                ) : (
                    <div className="mt-4 overflow-x-auto">
                        <table className="w-full border-collapse text-left text-sm">
                            <thead className="text-xs uppercase tracking-[0.15em] text-[var(--muted)]">
                                <tr>
                                    <th className="py-2 pr-4 font-medium">Requested</th>
                                    <th className="py-2 pr-4 font-medium">Amount</th>
                                    <th className="py-2 pr-4 font-medium">Network</th>
                                    <th className="py-2 pr-4 font-medium">Status</th>
                                    <th className="py-2 font-medium">Transaction</th>
                                </tr>
                            </thead>
                            <tbody>
                                {payoutResult.data.map((payout) => (
                                    <tr key={payout.id} className="border-t border-white/5 text-white/90">
                                        <td className="whitespace-nowrap py-3 pr-4 text-[var(--muted)]">{formatDate(payout.created_at)}</td>
                                        <td className="whitespace-nowrap py-3 pr-4">{fmtUsdPrecise(payout.amount_usd)} {payout.coin}</td>
                                        <td className="py-3 pr-4">{payout.network || "—"}</td>
                                        <td className="py-3 pr-4">{payout.status}</td>
                                        <td className="max-w-56 truncate py-3 font-mono text-xs text-[var(--muted)]">{payout.tx_hash || "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </main>
    );
}

function SummaryCard({ label, value }) {
    return (
        <div className="rounded-xl border border-white/10 bg-[var(--panel)] p-4">
            <p className="text-xs uppercase tracking-[0.15em] text-[var(--muted)]">{label}</p>
            <p className="mt-2 text-xl font-semibold tabular-nums text-white">{value}</p>
        </div>
    );
}

function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}
