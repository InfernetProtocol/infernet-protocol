"use client";

import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "infernet-admin-token";

function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}
function saveToken(t) {
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

function usd(n) {
    const v = Number(n) || 0;
    if (v === 0) return "$0.00";
    return Math.abs(v) >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(6).replace(/0+$/, "")}`;
}

/**
 * /admin/payouts client: lists pending withdrawal requests with one Approve
 * action each, the ledger totals, and the earnings settings (subsidy rate,
 * house fee, minimum payout, subsidy approval).
 */
export default function AdminPayouts() {
    const [token, setToken] = useState("");
    const [status, setStatus] = useState("requested");
    const [data, setData] = useState(null);
    const [config, setConfig] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(null);

    useEffect(() => { setToken(readToken()); }, []);

    const call = useCallback(async (path, init = {}) => {
        const res = await fetch(path, {
            ...init,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) }
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        return json.data;
    }, [token]);

    const load = useCallback(async () => {
        if (!token) return;
        setError(null);
        try {
            const [list, cfg] = await Promise.all([
                call(`/api/v1/admin/payouts?status=${encodeURIComponent(status)}`),
                call("/api/v1/admin/earnings/settings")
            ]);
            setData(list);
            setConfig(cfg);
        } catch (err) {
            setError(err.message);
        }
    }, [call, status, token]);

    useEffect(() => { load(); }, [load]);

    async function act(id, action, extra = {}) {
        const label = action === "approve" ? "SEND this payout now through CoinPay? This moves real funds." : `${action} this request?`;
        if (!window.confirm(label)) return;
        setBusy(id);
        try {
            const out = await call(`/api/v1/admin/payouts/${id}`, { method: "POST", body: JSON.stringify({ action, ...extra }) });
            if (out?.outcome && out.outcome !== "sent") setError(`outcome: ${out.outcome} ${out.request?.error ?? ""}`);
            await load();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(null);
        }
    }

    async function saveConfig(event) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = {
            subsidy_per_1k_output_usd: Number(form.get("subsidy_per_1k_output_usd")),
            house_fee_pct: Number(form.get("house_fee_pct")),
            min_payout_usd: Number(form.get("min_payout_usd")),
            subsidy_approved: form.get("subsidy_approved") === "on"
        };
        if (body.subsidy_approved && !config?.subsidy_approved &&
            !window.confirm("Approve the subsidy? Every credit pending approval becomes confirmed (withdrawable).")) return;
        setBusy("config");
        try {
            await call("/api/v1/admin/earnings/settings", { method: "POST", body: JSON.stringify(body) });
            await load();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(null);
        }
    }

    if (!token) {
        return (
            <form
                className="max-w-md space-y-3 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6"
                onSubmit={(e) => {
                    e.preventDefault();
                    const t = String(new FormData(e.currentTarget).get("token") ?? "").trim();
                    saveToken(t);
                    setToken(t);
                }}
            >
                <label className="block text-sm text-white" htmlFor="token">Admin token (INFERNET_ADMIN_TOKEN)</label>
                <input id="token" name="token" type="password" autoComplete="off"
                    className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white" />
                <button type="submit" className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black">Unlock</button>
                <p className="text-xs text-[var(--muted)]">Kept in this tab only (sessionStorage).</p>
            </form>
        );
    }

    const totals = data?.totals?.totals_usd ?? {};
    return (
        <div className="space-y-8">
            {error ? <p className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p> : null}

            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                    ["Subsidy pending approval", totals["subsidy:pending_approval"]],
                    ["Subsidy confirmed", totals["subsidy:confirmed"]],
                    ["Paid jobs awaiting client", totals["paid:pending"]],
                    ["Paid jobs confirmed", totals["paid:confirmed"]]
                ].map(([label, v]) => (
                    <div key={label} className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-5">
                        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">{label}</p>
                        <p className="mt-2 text-2xl font-semibold text-white">{usd(v)}</p>
                    </div>
                ))}
            </section>
            <p className="text-xs text-[var(--muted)]">
                {data?.totals?.credits ?? 0} credited jobs across {data?.totals?.providers ?? 0} providers.
            </p>

            <section className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--muted)]">Withdrawal requests</h2>
                    <div className="flex gap-2 text-xs">
                        {["requested", "sending", "sent", "all"].map((s) => (
                            <button key={s} type="button" onClick={() => setStatus(s)}
                                className={`rounded-full border px-3 py-1 ${status === s ? "border-[var(--accent)] text-[var(--accent)]" : "border-white/15 text-[var(--muted)]"}`}>
                                {s}
                            </button>
                        ))}
                        <button type="button" onClick={() => { saveToken(""); setToken(""); }}
                            className="rounded-full border border-white/15 px-3 py-1 text-[var(--muted)]">lock</button>
                    </div>
                </div>
                {!data?.rows?.length ? (
                    <p className="text-sm text-[var(--muted)]">No {status === "all" ? "" : status} requests.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="text-left text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                                    <th className="py-2 pr-3 font-medium">Node</th>
                                    <th className="py-2 pr-3 font-medium">Amount</th>
                                    <th className="py-2 pr-3 font-medium">To</th>
                                    <th className="py-2 pr-3 font-medium">Balance</th>
                                    <th className="py-2 pr-3 font-medium">Status</th>
                                    <th className="py-2 pr-3 font-medium">Asked</th>
                                    <th className="py-2 pr-3 font-medium" />
                                </tr>
                            </thead>
                            <tbody>
                                {data.rows.map((r) => (
                                    <tr key={r.id} className="border-t border-white/5 align-top">
                                        <td className="py-2 pr-3 text-white">
                                            <a href={`/nodes/${r.provider_id}`} className="hover:underline">{r.provider_name ?? r.provider_node_id ?? r.provider_id}</a>
                                        </td>
                                        <td className="py-2 pr-3 text-white">{usd(r.amount_usd)}</td>
                                        <td className="py-2 pr-3 font-mono text-xs text-[var(--muted)] break-all">{r.coin}{r.network ? ` (${r.network})` : ""}<br />{r.address}</td>
                                        <td className="py-2 pr-3 text-xs text-[var(--muted)]">
                                            confirmed {usd(r.balance?.confirmed_usd)}<br />paid {usd(r.balance?.paid_usd)}
                                        </td>
                                        <td className="py-2 pr-3 text-xs text-[var(--muted)]">{r.status}{r.error ? <><br />{r.error}</> : null}{r.tx_hash ? <><br />tx {r.tx_hash}</> : null}</td>
                                        <td className="py-2 pr-3 text-xs text-[var(--muted)]">{new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")}</td>
                                        <td className="py-2 pr-3">
                                            {r.status === "requested" ? (
                                                <div className="flex gap-2">
                                                    <button type="button" disabled={busy === r.id} onClick={() => act(r.id, "approve")}
                                                        className="rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-black disabled:opacity-50">Approve + send</button>
                                                    <button type="button" disabled={busy === r.id} onClick={() => act(r.id, "reject", { reason: window.prompt("Reason (shown to the provider)?") ?? undefined })}
                                                        className="rounded-full border border-white/15 px-3 py-1 text-xs text-white disabled:opacity-50">Reject</button>
                                                </div>
                                            ) : r.status === "sending" ? (
                                                <div className="flex gap-2">
                                                    <button type="button" disabled={busy === r.id}
                                                        onClick={() => { const tx = window.prompt("Tx hash seen on chain"); if (tx) act(r.id, "mark_sent", { tx_hash: tx }); }}
                                                        className="rounded-full border border-white/15 px-3 py-1 text-xs text-white">Mark sent</button>
                                                    <button type="button" disabled={busy === r.id} onClick={() => act(r.id, "mark_failed")}
                                                        className="rounded-full border border-white/15 px-3 py-1 text-xs text-white">Mark failed</button>
                                                </div>
                                            ) : null}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>

            {config ? (
                <form onSubmit={saveConfig} className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.25em] text-[var(--muted)]">Earnings settings</h2>
                    <div className="grid gap-4 sm:grid-cols-3">
                        <label className="text-sm text-white">Subsidy, USD per 1k output tokens
                            <input name="subsidy_per_1k_output_usd" type="number" step="0.000001" min="0" defaultValue={config.subsidy_per_1k_output_usd}
                                className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2" />
                        </label>
                        <label className="text-sm text-white">House fee on paid jobs, %
                            <input name="house_fee_pct" type="number" step="0.1" min="0" max="100" defaultValue={config.house_fee_pct}
                                className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2" />
                        </label>
                        <label className="text-sm text-white">Minimum payout, USD
                            <input name="min_payout_usd" type="number" step="0.01" min="0" defaultValue={config.min_payout_usd}
                                className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2" />
                        </label>
                    </div>
                    <label className="mt-4 flex items-center gap-2 text-sm text-white">
                        <input name="subsidy_approved" type="checkbox" defaultChecked={config.subsidy_approved} />
                        Subsidy approved (pending-approval credits become confirmed and withdrawable)
                    </label>
                    <p className="mt-2 text-xs text-[var(--muted)]">Changing the rate re-prices every credit still pending approval (including the backfilled ones); confirmed credits keep the rate they were confirmed at.</p>
                    <button type="submit" disabled={busy === "config"}
                        className="mt-4 rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black disabled:opacity-50">Save settings</button>
                </form>
            ) : null}
        </div>
    );
}
