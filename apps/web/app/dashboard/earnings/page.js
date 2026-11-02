import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getUserProviders } from "@/lib/data/dashboard";
import { getEarningsForProviders } from "@/lib/data/earnings";
import { EARNING_STATUS_LABELS, fmtUsdPrecise } from "@/lib/earnings/core";

export const dynamic = "force-dynamic";
export const metadata = { title: "All node earnings — Infernet" };

const PAGE_SIZE = 50;

export default async function EarningsDetailsPage({ searchParams }) {
    const user = await getCurrentUser();
    if (!user) redirect("/auth/login?next=/dashboard");

    const providers = await getUserProviders(user.id, { includeArchived: true });
    const providerIds = providers.map((provider) => provider.id);
    const query = (await searchParams) ?? {};
    const requestedPage = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const supabase = getSupabaseServerClient();

    const [summary, payoutResult] = await Promise.all([
        getEarningsForProviders(providerIds, { recent: Number.MAX_SAFE_INTEGER }),
        providerIds.length > 0
            ? supabase
                .from("payout_requests")
                .select("id, provider_id, amount_usd, coin, network, status, tx_hash, created_at")
                .in("provider_id", providerIds)
                .order("created_at", { ascending: false })
                .limit(100)
            : Promise.resolve({ data: [], error: null })
    ]);
    if (payoutResult.error) throw new Error(payoutResult.error.message);

    const providerById = new Map(providers.map((provider) => [provider.id, provider]));
    const jobsById = new Map();
    for (const entry of summary.recent ?? []) {
        // A reservation credit has no job: it is its own row.
        const key = entry.job_id ?? `reservation:${entry.reservation_id ?? entry.id}`;
        let job = jobsById.get(key);
        if (!job) {
            job = {
                key,
                job_id: entry.job_id ?? null,
                reservation_id: entry.reservation_id ?? null,
                earned_at: entry.earned_at,
                gross_usd: 0,
                fee_usd: 0,
                earned_usd: 0,
                output_tokens: 0,
                provider_ids: new Set(),
                kinds: new Set(),
                statuses: new Set(),
                model_name: entry.model_name ?? null,
                credit_entries: 0
            };
            jobsById.set(key, job);
        }
        job.credit_entries += 1;
        job.provider_ids.add(entry.provider_id);
        job.kinds.add(entry.kind);
        job.statuses.add(entry.status);
        if (!job.model_name && entry.model_name) job.model_name = entry.model_name;
        if (entry.earned_at > job.earned_at) job.earned_at = entry.earned_at;
        if (entry.status !== "void") {
            const amount = Number(entry.amount_usd) || 0;
            const fee = Number(entry.fee_usd) || 0;
            job.earned_usd += amount;
            job.fee_usd += fee;
            job.gross_usd += amount + fee;
            job.output_tokens += Number(entry.output_tokens) || 0;
        }
    }

    const allJobs = [...jobsById.values()].sort((a, b) => b.earned_at.localeCompare(a.earned_at));
    const totalJobs = allJobs.length;
    const totalPages = Math.max(1, Math.ceil(totalJobs / PAGE_SIZE));
    const page = Math.min(requestedPage, totalPages);
    const pageJobs = allJobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const jobIds = pageJobs.map((job) => job.job_id).filter(Boolean);
    let jobRecords = [];
    if (jobIds.length > 0) {
        const { data, error } = await supabase
            .from("jobs")
            .select("id, title, model_name")
            .in("id", jobIds);
        if (error) throw new Error(error.message);
        jobRecords = data ?? [];
    }
    const jobRecordById = new Map(jobRecords.map((job) => [job.id, job]));

    const balance = summary.balance;
    const earnedTotal = Number(balance.confirmed_usd ?? 0)
        + Number(balance.pending_usd ?? 0)
        + Number(balance.pending_approval_usd ?? 0);

    return (
        <main className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-10">
            <p className="mb-5 text-sm text-[var(--muted)]">
                <Link href="/dashboard#earnings" className="text-[var(--accent)] hover:underline">← Dashboard</Link>
            </p>
            <header className="mb-8">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">All provider nodes</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">Earnings across your nodes</h1>
                <p className="mt-2 text-sm text-[var(--muted)]">
                    One row per job across {providers.length} active and archived nodes. Credits from jobs served by multiple nodes are combined.
                    <span className="block">{totalJobs} unique jobs · {(summary.recent ?? []).length} provider credit entries</span>
                </p>
            </header>

            <section aria-label="Combined earnings summary" className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-7">
                <SummaryCard label="Total earned" value={fmtUsdPrecise(earnedTotal)} />
                <SummaryCard label="Confirmed" value={fmtUsdPrecise(balance.confirmed_usd)} />
                <SummaryCard label="Awaiting payment" value={fmtUsdPrecise(balance.pending_usd)} />
                <SummaryCard label="Pending approval" value={fmtUsdPrecise(balance.pending_approval_usd)} />
                <SummaryCard label="Payout in progress" value={fmtUsdPrecise(balance.requested_usd)} />
                <SummaryCard label="Paid out" value={fmtUsdPrecise(balance.paid_usd)} />
                <SummaryCard label="Available to withdraw" value={fmtUsdPrecise(balance.available_usd)} />
            </section>

            <section className="mb-10 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-5 sm:p-6">
                <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
                    <div>
                        <h2 className="text-lg font-semibold text-white">Jobs that earned credits</h2>
                        <p className="mt-1 text-sm text-[var(--muted)]">Amounts combine every provider credit for the same job.</p>
                    </div>
                    <p className="text-xs text-[var(--muted)]">Page {page} of {totalPages}</p>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-sm">
                        <thead className="text-xs uppercase tracking-[0.15em] text-[var(--muted)]">
                            <tr>
                                <th className="py-2 pr-4 font-medium">When</th>
                                <th className="py-2 pr-4 font-medium">Job / model</th>
                                <th className="py-2 pr-4 font-medium">Nodes</th>
                                <th className="py-2 pr-4 font-medium">Source</th>
                                <th className="py-2 pr-4 text-right font-medium">Output tokens</th>
                                <th className="py-2 pr-4 text-right font-medium">Gross</th>
                                <th className="py-2 pr-4 text-right font-medium">House fee</th>
                                <th className="py-2 pr-4 text-right font-medium">Earned</th>
                                <th className="py-2 font-medium">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {pageJobs.map((job) => {
                                const record = jobRecordById.get(job.job_id);
                                const nodeNames = [...job.provider_ids]
                                    .map((id) => providerById.get(id)?.name)
                                    .filter(Boolean);
                                const source = job.kinds.size > 1
                                    ? "Mixed"
                                    : job.kinds.has("subsidy")
                                        ? "Playground subsidy"
                                        : job.kinds.has("reservation")
                                            ? "Reservation"
                                            : "Paid inference";
                                const statuses = [...job.statuses]
                                    .map((status) => EARNING_STATUS_LABELS[status] ?? status);
                                return (
                                    <tr key={job.key} className="border-t border-white/5 text-white/90">
                                        <td className="whitespace-nowrap py-3 pr-4 text-[var(--muted)]">{formatDate(job.earned_at)}</td>
                                        <td className="max-w-72 py-3 pr-4">
                                            <span className="block truncate">{record?.title || (job.job_id ? `Job ${job.job_id.slice(0, 8)}` : `Reservation ${String(job.reservation_id ?? "").slice(0, 8)}`)}</span>
                                            <span className="block truncate text-xs text-[var(--muted)]">{record?.model_name ?? job.model_name ?? "Model not recorded"}</span>
                                        </td>
                                        <td className="max-w-64 py-3 pr-4 text-xs text-[var(--muted)]">{nodeNames.join(" · ") || "Provider unavailable"}</td>
                                        <td className="whitespace-nowrap py-3 pr-4">{source}</td>
                                        <td className="py-3 pr-4 text-right tabular-nums">{job.output_tokens.toLocaleString("en-US")}</td>
                                        <td className="py-3 pr-4 text-right tabular-nums">{fmtUsdPrecise(job.gross_usd)}</td>
                                        <td className="py-3 pr-4 text-right tabular-nums">{fmtUsdPrecise(job.fee_usd)}</td>
                                        <td className="py-3 pr-4 text-right font-medium tabular-nums">{fmtUsdPrecise(job.earned_usd)}</td>
                                        <td className="whitespace-nowrap py-3 text-xs">{statuses.join(" · ") || "—"}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                {pageJobs.length === 0 ? <p className="py-8 text-center text-sm text-[var(--muted)]">No earnings recorded across your nodes yet.</p> : null}
                {totalPages > 1 ? (
                    <nav aria-label="Job earnings pages" className="mt-4 flex justify-between border-t border-white/5 pt-4 text-sm">
                        {page > 1 ? <Link href={`/dashboard/earnings?page=${page - 1}`} className="text-[var(--accent)] hover:underline">← Newer jobs</Link> : <span />}
                        {page < totalPages ? <Link href={`/dashboard/earnings?page=${page + 1}`} className="text-[var(--accent)] hover:underline">Older jobs →</Link> : null}
                    </nav>
                ) : null}
            </section>

            <section className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-5 sm:p-6">
                <h2 className="text-lg font-semibold text-white">Payout history across nodes</h2>
                {(payoutResult.data ?? []).length === 0 ? (
                    <p className="mt-3 text-sm text-[var(--muted)]">No payouts requested yet.</p>
                ) : (
                    <div className="mt-4 overflow-x-auto">
                        <table className="w-full border-collapse text-left text-sm">
                            <thead className="text-xs uppercase tracking-[0.15em] text-[var(--muted)]">
                                <tr>
                                    <th className="py-2 pr-4 font-medium">Requested</th>
                                    <th className="py-2 pr-4 font-medium">Node</th>
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
                                        <td className="py-3 pr-4">{providerById.get(payout.provider_id)?.name ?? "Provider"}</td>
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
