import { redirect } from "next/navigation";
import Link from "next/link";
import RealtimeRefresh from "@/components/realtime-refresh";
import PushModelButton from "@/components/push-model-button";
import RevealTitle from "@/components/reveal-title";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { isAdminUser } from "@/lib/auth/admin";
import { fmtUsdPrecise, EARNING_STATUS_LABELS } from "@/lib/earnings/core";
import {
    getEarningsSummary,
    getSpendSummary,
    getUserClients,
    getUserModelsServed,
    getUserProviders,
    getUserPubkeys,
    getRecentJobs,
    getRecentJobsProcessed,
    summarizeHardware,
    summarizeInterconnects
} from "@/lib/data/dashboard";

export const metadata = {
    title: "Dashboard"
};
export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }) {
    const sp = (await searchParams) ?? {};
    const user = await getCurrentUser();
    if (!user) {
        redirect("/auth/login?next=/dashboard");
    }

    const [pubkeys, providers, clients, earnings, spend, models, jobs, jobsProcessed] = await Promise.all([
        getUserPubkeys(user.id),
        getUserProviders(user.id),
        getUserClients(user.id),
        getEarningsSummary(user.id),
        getSpendSummary(user.id),
        getUserModelsServed(user.id),
        getRecentJobs(user.id, { limit: 6 }),
        getRecentJobsProcessed(user.id, { limit: 8 })
    ]);

    const hardware = summarizeHardware(providers);
    const fabric = summarizeInterconnects(providers);
    const noProviders = providers.length === 0;
    const noClients = clients.length === 0;

    return (
        <>
            <main className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-10">
                <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
                            Dashboard
                        </p>
                        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                            Welcome, {user.email ?? "there"}.
                        </h1>
                        <p className="mt-2 text-sm text-[var(--muted)]">
                            Your nodes, jobs, and money flow on the Infernet network.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <RealtimeRefresh tables={["providers", "jobs"]} />
                        <CopyableUserId id={user.id} />
                        {isAdminUser(user) ? (
                            <Link
                                href="/admin/payouts"
                                className="rounded-full border border-[var(--accent)] px-4 py-2 text-sm text-[var(--accent)] hover:bg-white/10"
                            >
                                Payout approvals
                            </Link>
                        ) : null}
                        <form action="/api/auth/logout" method="post">
                            <button
                                type="submit"
                                className="rounded-full border border-white/15 px-4 py-2 text-sm text-white hover:bg-white/10"
                            >
                                Sign out
                            </button>
                        </form>
                    </div>
                </header>

                {/* Stat cards */}
                <section className="mb-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    <Stat
                        label="Earnings"
                        value={fmtUsdPrecise(earnings.confirmed_usd + earnings.pending_usd + earnings.pending_approval_usd)}
                        sub={`${fmtUsdPrecise(earnings.confirmed_usd)} confirmed · ${fmtUsdPrecise(earnings.pending_approval_usd)} pending approval · ${fmtUsdPrecise(earnings.paid_usd)} paid out · ${earnings.jobs_credited} jobs`}
                    />
                    <Stat
                        label="Spend (last 30d)"
                        value={spend.last_30d_usd}
                        sub={`${spend.all_time_usd} all-time · ${spend.confirmed_payments} confirmed`}
                    />
                    <Stat
                        label="Models served"
                        value={models.length}
                        sub={
                            models.length === 0
                                ? noProviders
                                    ? "Register a node to advertise models"
                                    : "Run `infernet model add <name>` to pull and advertise"
                                : models.slice(0, 4).join(" · ") + (models.length > 4 ? "…" : "")
                        }
                    />
                </section>

                {/* Hardware cards — equal billing for GPUs and CPUs */}
                <section className="mb-10 grid gap-4 sm:grid-cols-2">
                    <Stat
                        label="GPUs in use"
                        value={hardware.gpus.reduce((a, g) => a + g.count, 0)}
                        sub={
                            hardware.gpus.length > 0
                                ? hardware.gpus.map((g) => `${g.count}× ${g.model}`).join(" · ")
                                : noProviders
                                    ? "No registered providers yet"
                                    : "CPU-only providers"
                        }
                    />
                    <Stat
                        label="CPU cores in use"
                        value={hardware.cpus.reduce((a, c) => a + c.cores, 0)}
                        sub={
                            hardware.cpus.length > 0
                                ? hardware.cpus.map((c) => `${c.cores} × ${c.model}`).join(" · ")
                                : noProviders
                                    ? "No registered providers yet"
                                    : "Re-run `infernet register` to upload CPU info"
                        }
                    />
                </section>

                {/* Two-column body */}
                <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
                    {/* Nodes — CPU-only or GPU+CPU, both first-class */}
                    <Card title="Nodes (you operate)">
                        {noProviders ? (
                            <Empty
                                hint="You haven't linked a node to this account yet."
                                cli={`infernet login\ninfernet register`}
                            />
                        ) : (
                            <table className="w-full border-collapse text-sm">
                                <thead>
                                    <tr className="text-left text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                                        <th className="py-2 pr-3 font-medium">Node</th>
                                        <th className="py-2 pr-3 font-medium">GPU</th>
                                        <th className="py-2 pr-3 font-medium">CPU</th>
                                        <th className="py-2 pr-3 font-medium">Status</th>
                                        <th className="py-2 pr-3 font-medium">Last seen</th>
                                        <th className="py-2 pr-3 font-medium">Version</th>
                                        <th className="py-2 pr-3 font-medium">Models</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {providers.map((p) => (
                                        <tr key={p.id} className="border-t border-white/5">
                                            <td className="py-2 pr-3 text-white">{p.name}</td>
                                            <td className="py-2 pr-3 text-[var(--muted)]">{nodeGpuLabel(p)}</td>
                                            <td className="py-2 pr-3 text-[var(--muted)]">{nodeCpuLabel(p)}</td>
                                            <td className="py-2 pr-3"><StatusPill status={p.status} /></td>
                                            <td className="py-2 pr-3 text-[var(--muted)]">{relTime(p.last_seen)}</td>
                                            <td className="py-2 pr-3 text-[var(--muted)] text-xs">{p.specs?.cli_version ?? "—"}</td>
                                            <td className="relative py-2 pr-3">
                                                {p.public_key ? <PushModelButton pubkey={p.public_key} servedModels={p.specs?.served_models ?? []} specs={p.specs} /> : <span className="text-xs text-[var(--muted)]">—</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </Card>

                    {/* CPU groups + linked pubkeys */}
                    <div className="space-y-6">
                        <Card title="CPU pool">
                            {hardware.cpus.length === 0 ? (
                                <p className="text-sm text-[var(--muted)]">
                                    No CPU specs reported. Re-run <code>infernet register</code> to upload host CPU info.
                                </p>
                            ) : (
                                <ul className="space-y-1 text-sm">
                                    {hardware.cpus.map((c, i) => (
                                        <li key={i} className="flex items-baseline justify-between gap-3">
                                            <span className="text-white">{c.model}</span>
                                            <span className="text-[var(--muted)]">{c.cores} cores</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>

                        <Card title="Interconnect">
                            {!noProviders ? (
                                <ul className="space-y-1.5 text-sm">
                                    <li className="flex items-baseline justify-between gap-3">
                                        <span className="text-white">NVLink</span>
                                        <span className="text-[var(--muted)]">
                                            {fabric.any_nvlink
                                                ? `yes${fabric.nvlink_topologies.length ? ` · ${fabric.nvlink_topologies.join(", ")}` : ""}`
                                                : "no"}
                                        </span>
                                    </li>
                                    <li className="flex items-baseline justify-between gap-3">
                                        <span className="text-white">xGMI / Infinity Fabric</span>
                                        <span className="text-[var(--muted)]">
                                            {fabric.any_xgmi
                                                ? `yes${fabric.xgmi_topologies.length ? ` · ${fabric.xgmi_topologies.join(", ")}` : ""}`
                                                : "no"}
                                        </span>
                                    </li>
                                    <li className="flex items-baseline justify-between gap-3">
                                        <span className="text-white">InfiniBand</span>
                                        <span className="text-[var(--muted)]">
                                            {fabric.any_infiniband ? "yes" : "no"}
                                        </span>
                                    </li>
                                    <li className="flex items-baseline justify-between gap-3">
                                        <span className="text-white">AWS EFA</span>
                                        <span className="text-[var(--muted)]">
                                            {fabric.any_efa ? "yes" : "no"}
                                        </span>
                                    </li>
                                    <li className="flex items-baseline justify-between gap-3">
                                        <span className="text-white">RDMA-capable nodes</span>
                                        <span className="text-[var(--muted)]">
                                            {fabric.rdma_capable_providers} / {providers.length}
                                        </span>
                                    </li>
                                </ul>
                            ) : (
                                <p className="text-sm text-[var(--muted)]">
                                    NVLink + InfiniBand are auto-detected when you register a node.
                                    Run <code>infernet setup</code> to see what your hardware reports.
                                </p>
                            )}
                        </Card>

                        <Card title="Linked identities">
                            {pubkeys.length === 0 ? (
                                <Empty
                                    hint="No Nostr pubkeys linked. Link one with `infernet pubkey link`."
                                    cli={`infernet pubkey link --role provider`}
                                />
                            ) : (
                                <ul className="space-y-2 text-sm">
                                    {pubkeys.map((k) => (
                                        <li key={k.pubkey} className="flex flex-col gap-0.5">
                                            <span className="text-white">{k.label || "(no label)"} <span className="text-xs text-[var(--muted)]">[{k.role}]</span></span>
                                            <span className="font-mono text-xs text-[var(--muted)]">{shortPubkey(k.pubkey)}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Card>
                    </div>
                </div>

                {!noProviders ? (
                    <section id="earnings" className="mt-10">
                        <Card title="Earnings + payouts">
                            <EarningsPanel providers={providers} earnings={earnings} notice={sp.payout} error={sp.payout_error} />
                        </Card>
                    </section>
                ) : null}

                {/* Operator-side view: jobs your nodes actually processed */}
                <section className="mt-10">
                    <Card title="Recent jobs (your nodes processed)">
                        {noProviders || jobsProcessed.length === 0 ? (
                            <Empty
                                hint={
                                    noProviders
                                        ? "No providers registered yet — register a node to start earning."
                                        : "Your nodes haven't processed jobs yet. Once a chat or batch lands here it'll show up."
                                }
                                cli="infernet status"
                            />
                        ) : (
                            <table className="w-full border-collapse text-sm">
                                <thead>
                                    <tr className="text-left text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                                        <th className="py-2 pr-3 font-medium">Title</th>
                                        <th className="py-2 pr-3 font-medium">Model</th>
                                        <th className="py-2 pr-3 font-medium">Node</th>
                                        <th className="py-2 pr-3 font-medium">Status</th>
                                        <th className="py-2 pr-3 font-medium">Earned</th>
                                        <th className="py-2 pr-3 font-medium">When</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {jobsProcessed.map((j) => (
                                        <tr key={j.id} className="border-t border-white/5">
                                            <td className="py-2 pr-3"><RevealTitle prompt={j.prompt} /></td>
                                            <td className="py-2 pr-3 text-[var(--muted)]">{j.model_name || "—"}</td>
                                            <td className="py-2 pr-3 text-[var(--muted)]">
                                                {j.provider_id ? (
                                                    <Link
                                                        href={`/nodes/${j.provider_id}`}
                                                        className="text-[var(--accent)] hover:underline"
                                                    >
                                                        {j.provider_name ?? j.provider_node_id ?? "node"}
                                                    </Link>
                                                ) : "—"}
                                            </td>
                                            <td className="py-2 pr-3"><StatusPill status={j.status} /></td>
                                            <td className="py-2 pr-3 text-[var(--muted)]">
                                                {j.earned_usd != null ? (
                                                    <>
                                                        {fmtUsdPrecise(j.earned_usd)}
                                                        <span className="block text-[10px] uppercase tracking-wider">
                                                            {EARNING_STATUS_LABELS[j.earned_status] ?? j.earned_status}
                                                            {j.output_tokens ? ` · ${j.output_tokens} tok` : ""}
                                                        </span>
                                                    </>
                                                ) : j.status === "completed" ? "crediting…" : "—"}
                                            </td>
                                            <td className="py-2 pr-3 text-[var(--muted)]">
                                                <JobTime iso={j.completed_at ?? j.created_at} />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </Card>
                </section>

                {/* Client-side view: jobs you submitted */}
                <section className="mt-10">
                    <Card title="Recent jobs (you submitted)">
                        {noClients || jobs.length === 0 ? (
                            <Empty
                                hint="No jobs yet from your client identities."
                                cli={`infernet "what is the speed of light?"`}
                            />
                        ) : (
                            <table className="w-full border-collapse text-sm">
                                <thead>
                                    <tr className="text-left text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                                        <th className="py-2 pr-3 font-medium">Title</th>
                                        <th className="py-2 pr-3 font-medium">Model</th>
                                        <th className="py-2 pr-3 font-medium">Status</th>
                                        <th className="py-2 pr-3 font-medium">Offer</th>
                                        <th className="py-2 pr-3 font-medium">When</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {jobs.map((j) => (
                                        <tr key={j.id} className="border-t border-white/5">
                                            <td className="py-2 pr-3"><RevealTitle prompt={j.prompt} /></td>
                                            <td className="py-2 pr-3 text-[var(--muted)]">{j.model_name || "—"}</td>
                                            <td className="py-2 pr-3"><StatusPill status={j.status} /></td>
                                            <td className="py-2 pr-3 text-[var(--muted)]">{fmtUsd(j.payment_offer)}</td>
                                            <td className="py-2 pr-3 text-[var(--muted)]"><JobTime iso={j.created_at} /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </Card>
                </section>

                {/* Help nudge */}
                <section className="mt-10 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6 text-sm text-[var(--muted)]">
                    <p>
                        New here? See the{" "}
                        <Link href="/docs#quick-start" className="text-[var(--accent)] hover:underline">
                            quick start
                        </Link>{" "}
                        or jump to the{" "}
                        <Link href="/chat" className="text-[var(--accent)] hover:underline">
                            chat playground
                        </Link>
                        . Network-wide stats live on{" "}
                        <Link href="/status" className="text-[var(--accent)] hover:underline">
                            /status
                        </Link>
                        .
                    </p>
                </section>
            </main>
        </>
    );
}

function EarningsPanel({ providers, earnings, notice, error }) {
    const cfg = earnings.config ?? {};
    const minPayout = Number(cfg.min_payout_usd ?? 0);
    return (
        <div className="space-y-5 text-sm">
            {notice === "requested" ? (
                <p className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-emerald-100">
                    Withdrawal requested. It is sent after an admin approves it.
                </p>
            ) : notice === "sent" ? (
                <p className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-emerald-100">
                    Withdrawal sent. The transaction is listed below.
                </p>
            ) : null}
            {error ? (
                <p className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-red-200">{String(error)}</p>
            ) : null}
            <p className="text-[var(--muted)]">
                Every completed job credits the node that served it. Free playground jobs earn a house subsidy of{" "}
                {fmtUsdPrecise(cfg.subsidy_per_1k_output_usd)} per 1k output tokens
                {cfg.subsidy_approved ? "" : ", shown as pending approval until the rate is approved"}. Earnings accrue with or
                without a payout address; you only need one to withdraw. Minimum withdrawal {fmtUsdPrecise(minPayout)}.{" "}
                <Link href="/docs#earnings" className="text-[var(--accent)] hover:underline">How earnings work</Link>
            </p>
            <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="text-left text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                            <th className="py-2 pr-3 font-medium">Node</th>
                            <th className="py-2 pr-3 font-medium">Pending approval</th>
                            <th className="py-2 pr-3 font-medium">Awaiting client</th>
                            <th className="py-2 pr-3 font-medium">Confirmed</th>
                            <th className="py-2 pr-3 font-medium">Paid out</th>
                            <th className="py-2 pr-3 font-medium">Available</th>
                            <th className="py-2 pr-3 font-medium">Date</th>
                            <th className="py-2 pr-3 font-medium" />
                        </tr>
                    </thead>
                    <tbody>
                        {providers.map((p) => {
                            const b = earnings.per_provider?.[p.id] ?? {};
                            const open = (earnings.payouts ?? []).find(
                                (r) => r.provider_id === p.id && ["requested", "approved", "sending"].includes(r.status)
                            );
                            const canWithdraw = !open && Number(b.available_usd) >= minPayout && Number(b.available_usd) > 0;
                            return (
                                <tr key={p.id} className="border-t border-white/5">
                                    <td className="py-2 pr-3 text-white">
                                        <Link href={`/nodes/${p.id}`} className="hover:underline">{p.name}</Link>
                                        <span className="block text-xs text-[var(--muted)]">{b.jobs_credited ?? 0} jobs credited</span>
                                    </td>
                                    <td className="py-2 pr-3 text-[var(--muted)]">{fmtUsdPrecise(b.pending_approval_usd)}</td>
                                    <td className="py-2 pr-3 text-[var(--muted)]">{fmtUsdPrecise(b.pending_usd)}</td>
                                    <td className="py-2 pr-3 text-white">{fmtUsdPrecise(b.confirmed_usd)}</td>
                                    <td className="py-2 pr-3 text-[var(--muted)]">{fmtUsdPrecise(b.paid_usd)}</td>
                                    <td className="py-2 pr-3 text-white">{fmtUsdPrecise(b.available_usd)}</td>
                                    <td className="py-2 pr-3 whitespace-nowrap text-[var(--muted)]">
                                        {formatDateTime(b.latest_earned_at)}
                                    </td>
                                    <td className="py-2 pr-3">
                                        {open ? (
                                            <span className="text-xs text-amber-200">{fmtUsdPrecise(open.amount_usd)} {open.status}</span>
                                        ) : (
                                            <form action="/api/v1/user/payouts/request" method="post">
                                                <input type="hidden" name="provider_id" value={p.id} />
                                                <button
                                                    type="submit"
                                                    disabled={!canWithdraw}
                                                    title={canWithdraw ? "Request a withdrawal of the available balance" : `Available balance is below the ${fmtUsdPrecise(minPayout)} minimum`}
                                                    className="rounded-full border border-white/15 px-3 py-1 text-xs text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                                                >
                                                    Withdraw
                                                </button>
                                            </form>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {(earnings.payouts ?? []).length > 0 ? (
                <div>
                    <p className="mb-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Withdrawals</p>
                    <ul className="space-y-1 text-xs text-[var(--muted)]">
                        {earnings.payouts.map((r) => (
                            <li key={r.id}>
                                {formatDateTime(r.created_at)} · {fmtUsdPrecise(r.amount_usd)} {r.coin} · {r.status}
                                {r.tx_hash ? ` · tx ${r.tx_hash.slice(0, 14)}…` : ""}
                                {r.status === "rejected" && r.error ? ` · ${r.error}` : ""}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            <pre className="overflow-x-auto rounded-lg bg-[var(--panel-strong)] p-3 text-xs leading-5 text-[var(--accent)]">
{`infernet payout list            # balance, ledger, address
infernet payout set USDC 0x... --network polygon  # where withdrawals go
infernet payout request         # withdraw the available balance`}
            </pre>
        </div>
    );
}

function Stat({ label, value, sub }) {
    return (
        <div className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-5 backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-[var(--muted)]">{label}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-white">{value}</p>
            {sub ? <p className="mt-2 text-xs text-[var(--muted)]">{sub}</p> : null}
        </div>
    );
}

function Card({ title, children }) {
    return (
        <section className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6 backdrop-blur">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.25em] text-[var(--muted)]">
                {title}
            </h2>
            {children}
        </section>
    );
}

function Empty({ hint, cli }) {
    return (
        <div className="space-y-3">
            <p className="text-sm text-[var(--muted)]">{hint}</p>
            {cli ? (
                <pre className="overflow-x-auto rounded-lg bg-[var(--panel-strong)] p-3 text-xs leading-5 text-[var(--accent)]">
                    {cli}
                </pre>
            ) : null}
        </div>
    );
}

function StatusPill({ status }) {
    const tone =
        status === "available" || status === "active" || status === "confirmed"
            ? "bg-emerald-400/15 text-emerald-200 border-emerald-400/30"
            : status === "busy" || status === "running" || status === "pending"
                ? "bg-amber-400/15 text-amber-100 border-amber-400/30"
                : status === "failed" || status === "offline"
                    ? "bg-red-400/15 text-red-200 border-red-400/30"
                    : "bg-white/5 text-[var(--muted)] border-white/10";
    return (
        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${tone}`}>
            {status ?? "—"}
        </span>
    );
}

function CopyableUserId({ id }) {
    return (
        <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[var(--panel-strong)] px-3 py-2 font-mono text-xs text-[var(--muted)]">
            id: {id.slice(0, 8)}…
        </span>
    );
}

function shortPubkey(k) {
    if (!k) return "";
    return `${k.slice(0, 8)}…${k.slice(-6)}`;
}

function relTime(iso) {
    if (!iso) return "—";
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

function formatDateTime(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short"
    }).format(date);
}

function JobTime({ iso }) {
    return (
        <span title={formatDateTime(iso)}>
            <span className="block">{relTime(iso)}</span>
            <span className="block text-[10px]">{formatDateTime(iso)}</span>
        </span>
    );
}

function nodeGpuLabel(p) {
    const specs = p?.specs && typeof p.specs === "object" ? p.specs : {};
    if (Array.isArray(specs.gpus) && specs.gpus.length > 0) {
        const first = specs.gpus[0];
        const more = specs.gpus.length > 1 ? ` +${specs.gpus.length - 1}` : "";
        return `${first.model ?? first.vendor ?? "GPU"}${more}`;
    }
    return p?.gpu_model || "—";
}

function nodeCpuLabel(p) {
    const c = p?.specs?.cpu;
    if (!c || typeof c !== "object") return "—";
    const parts = [];
    if (c.vendor) parts.push(c.vendor);
    if (c.arch) parts.push(c.arch);
    if (Number.isFinite(c.cores)) parts.push(`${c.cores} cores`);
    return parts.length ? parts.join(" · ") : "—";
}

function fmtUsd(value) {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return "$0.00";
    return n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}
