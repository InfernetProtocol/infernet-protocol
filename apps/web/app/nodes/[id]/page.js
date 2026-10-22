import { notFound } from "next/navigation";
import Link from "next/link";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getNodeActivity } from "@/lib/data/infernet";
import { formatGeo } from "@/lib/geo";
import { fmtUsdPrecise, EARNING_STATUS_LABELS } from "@/lib/earnings/core";

export const dynamic = "force-dynamic";

const ONLINE_WINDOW_MS = 10 * 60 * 1000;

export async function generateMetadata({ params }) {
    const { id } = await params;
    return {
        title: `Node ${id} — Infernet`,
        description: `Public details for Infernet node ${id}: location, hardware, models served and jobs.`
    };
}

/**
 * Public node details page. Shows operator-friendly info for one
 * provider/aggregator/client by id: where it is (coarse IP location,
 * never the IP), what it can run, what it is doing, and whether
 * aggregators can reach it. Honors the per-node is_public opt-out —
 * nodes with is_public=false return 404 even when they exist, so
 * search engines and curious clickers can't browse a private node by
 * guessing its UUID. Job rows never include prompt or output content.
 */
export default async function NodeDetailsPage({ params }) {
    const { id } = await params;
    const node = await loadPublicNode(id);
    if (!node) notFound();
    const activity = node.role === "client" ? {} : await getNodeActivity({ id: node.id, role: node.role }).catch(() => ({}));

    const specs = (node.specs && typeof node.specs === "object") ? node.specs : {};
    const gpus = Array.isArray(specs.gpus) ? specs.gpus : [];
    const cpu = specs.cpu ?? null;
    const load = specs.load ?? null;
    const bench = specs.bench ?? null;
    const servedModels = Array.isArray(specs.served_models) ? specs.served_models : [];
    const interconnects = specs.interconnects ?? null;
    const lastSeen = node.last_seen ? new Date(node.last_seen) : null;
    const lastSeenAgo = lastSeen ? humanAgo(Date.now() - lastSeen.getTime()) : "never";
    const online = node.status === "available" && lastSeen && Date.now() - lastSeen.getTime() < ONLINE_WINDOW_MS;
    const location = formatGeo(node.geo);
    const jobs = activity.jobs ?? null;
    const verification = activity.verification ?? null;

    return (
        <main className="mx-auto w-full max-w-4xl px-6 py-12 lg:px-10">
            <header className="mb-8 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
                    <Link href="/status" className="hover:underline">Status</Link> / {node.role}
                </p>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl break-words">
                    {node.name ?? node.node_id ?? id}
                </h1>
                <p className="text-sm text-[var(--muted)]">
                    <span className={online ? "text-emerald-400" : "text-amber-400"}>
                        {online ? "online" : "offline"}
                    </span>
                    {" · "}Last heartbeat: {lastSeenAgo}
                    {node.created_at ? <>{" · "}Joined {new Date(node.created_at).toISOString().slice(0, 10)}</> : null}
                    {specs.cli_version ? (
                        <>
                            {" · "}CLI: <span className="font-mono text-white">{specs.cli_version}</span>
                        </>
                    ) : null}
                </p>
            </header>

            <section className="mb-8 grid gap-4 sm:grid-cols-2">
                <Card label="Location">
                    {location ? (
                        <span className="text-sm text-white">{location}</span>
                    ) : (
                        <span className="text-[var(--muted)]">not known yet (set on the next heartbeat)</span>
                    )}
                </Card>
                <Card label="Reachability">
                    {verification ? (
                        <span className="text-sm text-white">
                            {verification.reachable_from > 0
                                ? `Reached by ${verification.reachable_from} of ${verification.aggregators} aggregators in the last hour`
                                : `Not reachable from ${verification.aggregators} aggregators in the last hour`}
                            {verification.median_rtt_ms != null ? ` · ${verification.median_rtt_ms} ms median` : ""}
                        </span>
                    ) : specs.reachable ? (
                        <span className="text-sm text-white">
                            Self-check: {specs.reachable.ok ? "inbound port open" : "inbound port closed (outbound-only)"}
                        </span>
                    ) : (
                        <span className="text-[var(--muted)]">no checks yet</span>
                    )}
                </Card>
                <Card label="GPUs">
                    {gpus.length === 0 ? (
                        <span className="text-[var(--muted)]">none (CPU inference)</span>
                    ) : (
                        <ul className="space-y-1 text-sm text-white">
                            {gpus.map((g, i) => (
                                <li key={i}>
                                    {g.vendor ?? "?"} · {g.model ?? "?"} · {g.vram_tier ?? g.vram_gb ?? "?"} GB
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
                <Card label="CPU">
                    {cpu ? (
                        <span className="text-sm text-white">
                            {[cpu.vendor, cpu.arch].filter(Boolean).join(" ") || "CPU"} · {cpu.cores ?? "?"} cores · {cpu.ram_gb ?? "?"} GB RAM
                        </span>
                    ) : (
                        <span className="text-[var(--muted)]">none advertised</span>
                    )}
                </Card>
                {load ? (
                    <Card label="Live load">
                        <span className="text-sm text-white">
                            {load.active_jobs ?? 0} active job{load.active_jobs === 1 ? "" : "s"}
                            {load.load_avg_1m != null ? ` · load ${load.load_avg_1m}` : ""}
                            {load.ram ? ` · ${load.ram.free_gb} of ${load.ram.total_gb} GB RAM free` : ""}
                            {load.vram?.total_gb ? ` · ${load.vram.free_gb} of ${load.vram.total_gb} GB VRAM free` : ""}
                            {load.gpu_utilization_max != null ? ` · GPU ${load.gpu_utilization_max}%` : ""}
                        </span>
                    </Card>
                ) : null}
                {bench ? (
                    <Card label="Measured speed">
                        <span className="text-sm text-white">
                            {bench.tokens_per_second_avg} tokens/s average over its last {bench.samples} jobs
                        </span>
                    </Card>
                ) : null}
            </section>

            {node.role === "aggregator" ? (
                <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">What it is doing</h2>
                    {activity.aggregator ? (
                        <p className="mt-2 text-sm text-white">
                            In the last hour it probed {activity.aggregator.providers} providers
                            ({activity.aggregator.probes} probes, {activity.aggregator.reachable} reachable
                            {activity.aggregator.median_rtt_ms != null ? `, ${activity.aggregator.median_rtt_ms} ms median` : ""}).
                        </p>
                    ) : (
                        <p className="mt-2 text-sm text-[var(--muted)]">No probe reports in the last hour.</p>
                    )}
                </section>
            ) : null}

            {node.role === "provider" ? (
                <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">Models served</h2>
                    {servedModels.length === 0 ? (
                        <p className="mt-2 text-sm text-[var(--muted)]">
                            This node hasn&apos;t advertised any models in its most recent heartbeat.
                        </p>
                    ) : (
                        <ul className="mt-3 grid gap-2 sm:grid-cols-2 text-sm text-white">
                            {servedModels.map((m, i) => (
                                <li key={i} className="rounded-lg border border-white/10 bg-[var(--panel-strong)] px-3 py-2">
                                    {typeof m === "string" ? m : m?.name ?? "(unknown)"}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            ) : null}

            {jobs ? (
                <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">Jobs</h2>
                    <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                        <Stat label="Last 24 h" value={jobs.last24h} />
                        <Stat label="Last 7 days" value={jobs.last7d} />
                        <Stat label="All time" value={jobs.total} />
                        <Stat label="Success" value={jobs.success_rate != null ? `${jobs.success_rate}%` : "—"} />
                    </dl>
                    {activity.earnings ? (
                        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                            <Stat label="Earned, pending approval" value={fmtUsdPrecise(activity.earnings.pending_approval_usd)} />
                            <Stat label="Earned, confirmed" value={fmtUsdPrecise(activity.earnings.confirmed_usd)} />
                            <Stat label="Awaiting client payment" value={fmtUsdPrecise(activity.earnings.pending_usd)} />
                            <Stat label="Paid out" value={fmtUsdPrecise(activity.earnings.paid_usd)} />
                        </dl>
                    ) : null}
                    {activity.recent?.length ? (
                        <div className="mt-5 overflow-x-auto">
                            <table className="min-w-full text-left text-sm">
                                <thead className="text-[var(--muted)]">
                                    <tr>
                                        <th className="py-2 pr-4 font-medium">When</th>
                                        <th className="py-2 pr-4 font-medium">Type</th>
                                        <th className="py-2 pr-4 font-medium">Model</th>
                                        <th className="py-2 pr-4 font-medium">Status</th>
                                        <th className="py-2 pr-4 font-medium">Took</th>
                                        <th className="py-2 font-medium">Earned</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {activity.recent.map((j) => (
                                        <tr key={j.id} className="border-t border-white/10 text-white/90">
                                            <td className="py-2 pr-4">{j.when}</td>
                                            <td className="py-2 pr-4">{j.type}</td>
                                            <td className="py-2 pr-4 font-mono text-xs">{j.model}</td>
                                            <td className="py-2 pr-4">{j.status}</td>
                                            <td className="py-2 pr-4">{j.duration_ms != null ? formatDuration(j.duration_ms) : "—"}</td>
                                            <td className="py-2">
                                                {j.earned_usd != null ? (
                                                    <>
                                                        {fmtUsdPrecise(j.earned_usd)}
                                                        <span className="block text-[10px] uppercase tracking-wider text-[var(--muted)]">
                                                            {EARNING_STATUS_LABELS[j.earned_status] ?? j.earned_status}
                                                        </span>
                                                    </>
                                                ) : "—"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <p className="mt-3 text-sm text-[var(--muted)]">No jobs yet.</p>
                    )}
                </section>
            ) : null}

            {interconnects ? (
                <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">Interconnect</h2>
                    <ul className="mt-3 space-y-1 text-sm text-[var(--muted)]">
                        {Object.entries(interconnects).map(([k, v]) => (
                            <li key={k}>
                                <span className="uppercase tracking-[0.2em] text-xs text-[var(--accent)] mr-2">{k}</span>
                                <span className="text-white">{typeof v === "object" && v ? (v.available ? "available" : "no") : String(v)}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            <section className="mb-8 grid gap-4 sm:grid-cols-2">
                <Card label="Node ID">
                    <code className="break-all text-xs text-[var(--accent)]">{node.node_id ?? id}</code>
                </Card>
                <Card label="Pubkey">
                    {node.public_key ? (
                        <code className="break-all text-xs text-[var(--accent)]">{node.public_key}</code>
                    ) : (
                        <span className="text-[var(--muted)]">—</span>
                    )}
                </Card>
            </section>

            <section className="rounded-[1.5rem] border border-white/10 bg-[var(--panel-strong)] p-6 text-sm text-[var(--muted)]">
                <p>
                    This is a public view of an Infernet node. Location is a coarse IP lookup; the
                    address itself is not shown, and job prompts and outputs never are. Operators
                    control visibility per-node from{" "}
                    <Link href="/settings" className="text-[var(--accent)] hover:underline">
                        Settings
                    </Link>
                    {" "}or via <code>INFERNET_PUBLIC=0</code> at registration time.
                </p>
            </section>
        </main>
    );
}

function Card({ label, children }) {
    return (
        <div className="rounded-[1.25rem] border border-white/10 bg-[var(--panel)] p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">{label}</p>
            <div className="mt-2">{children}</div>
        </div>
    );
}

function Stat({ label, value }) {
    return (
        <div className="rounded-lg border border-white/10 bg-[var(--panel-strong)] px-3 py-2">
            <dt className="text-xs text-[var(--muted)]">{label}</dt>
            <dd className="mt-1 text-lg font-semibold text-white">{value}</dd>
        </div>
    );
}

async function loadPublicNode(id) {
    const supabase = getSupabaseServerClient();
    // Try providers first (most common), then aggregators, then clients.
    // Each table honors is_public; non-public rows return null →
    // notFound() at the page level so existence isn't leaked.
    const columns = {
        providers: "id, name, node_id, status, last_seen, created_at, specs, public_key, geo, is_public",
        aggregators: "id, name, node_id, status, last_seen, created_at, specs, public_key, geo, is_public",
        clients: "id, name, node_id, status, last_seen, created_at, public_key, is_public"
    };
    for (const table of ["providers", "aggregators", "clients"]) {
        const { data } = await supabase
            .from(table)
            .select(columns[table])
            .eq("id", id)
            .eq("is_public", true)
            .maybeSingle();
        if (data) return { ...data, role: table.slice(0, -1) };
    }
    return null;
}

function humanAgo(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "never";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function formatDuration(ms) {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.round(ms / 60_000)} min`;
}
