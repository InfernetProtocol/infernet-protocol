"use client";

import { useCallback, useEffect, useState } from "react";

async function api(path, init = {}) {
    const res = await fetch(path, {
        credentials: "same-origin",
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) }
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `request failed (${res.status})`);
    return json?.data ?? json;
}

const usd = (v) => `$${Number(v ?? 0).toFixed(Number(v) > 0 && Number(v) < 0.01 ? 6 : 2)}`;
const card = "rounded-xl border border-white/10 bg-white/[0.02] p-4";

export default function BillingPanel() {
    const [balance, setBalance] = useState(null);
    const [keys, setKeys] = useState([]);
    const [batches, setBatches] = useState([]);
    const [error, setError] = useState("");
    const [newKey, setNewKey] = useState("");
    const [keyName, setKeyName] = useState("");
    const [topup, setTopup] = useState("5.00");
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setError("");
        try {
            const [b, k, list] = await Promise.all([
                api("/api/v1/billing/balance"),
                api("/api/v1/keys"),
                api("/api/v1/batches?limit=20")
            ]);
            setBalance(b);
            setKeys(Array.isArray(k) ? k : (k?.keys ?? k?.data ?? []));
            setBatches(Array.isArray(list) ? list : (list?.data ?? []));
        } catch (e) {
            setError(e.message);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    async function createKey(e) {
        e.preventDefault();
        setBusy(true); setError(""); setNewKey("");
        try {
            const out = await api("/api/v1/keys", { method: "POST", body: JSON.stringify({ name: keyName || undefined }) });
            setNewKey(out?.key ?? out?.api_key ?? "");
            setKeyName("");
            await load();
        } catch (err) { setError(err.message); } finally { setBusy(false); }
    }

    async function revoke(id) {
        if (!window.confirm("Revoke this key? Anything using it stops working immediately.")) return;
        setBusy(true); setError("");
        try { await api(`/api/v1/keys/${id}`, { method: "DELETE" }); await load(); }
        catch (err) { setError(err.message); } finally { setBusy(false); }
    }

    async function startTopup(e) {
        e.preventDefault();
        setBusy(true); setError("");
        try {
            const out = await api("/api/v1/billing/topup", { method: "POST", body: JSON.stringify({ amount_usd: topup }) });
            const url = out?.checkout_url ?? out?.topup?.checkout_url;
            if (url) window.location.assign(url);
            else setError("no checkout link came back; try again");
        } catch (err) { setError(err.message); } finally { setBusy(false); }
    }

    return (
        <div className="space-y-5 text-sm">
            {error ? <p className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-red-200">{error}</p> : null}

            <section className={card}>
                <h2 className="mb-3 font-semibold text-white">What you can spend</h2>
                {balance ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div><div className="text-[var(--muted)]">Node earnings (used first)</div><div className="text-lg text-white">{usd(balance.earned_spendable_usd)}</div></div>
                        <div><div className="text-[var(--muted)]">Prepaid available</div><div className="text-lg text-white">{usd(balance.prepaid_available_usd)}</div>{Number(balance.held_usd) > 0 ? <div className="text-xs text-[var(--muted)]">{usd(balance.held_usd)} held by running batches</div> : null}</div>
                        <div><div className="text-[var(--muted)]">Total spendable</div><div className="text-lg text-white">{usd(balance.total_spendable_usd)}</div></div>
                    </div>
                ) : <p className="text-[var(--muted)]">Loading…</p>}
                <form onSubmit={startTopup} className="mt-4 flex flex-wrap items-center gap-2">
                    <label htmlFor="topup" className="text-[var(--muted)]">Add prepaid funds (USD)</label>
                    <input id="topup" inputMode="decimal" value={topup} onChange={(e) => setTopup(e.target.value)} className="w-28 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-white" />
                    <button type="submit" disabled={busy} className="rounded-md bg-[var(--accent)] px-3 py-1 font-medium text-black disabled:opacity-50">Pay with CoinPay</button>
                    <span className="text-xs text-[var(--muted)]">Credited once CoinPay confirms the full amount.</span>
                </form>
            </section>

            <section className={card}>
                <h2 className="mb-3 font-semibold text-white">API keys</h2>
                {newKey ? (
                    <div className="mb-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-emerald-100">
                        <div className="mb-1">Your new key. Copy it now: it is shown once.</div>
                        <code className="block break-all text-white">{newKey}</code>
                    </div>
                ) : null}
                <form onSubmit={createKey} className="mb-3 flex flex-wrap gap-2">
                    <input aria-label="Key name" placeholder="name (optional)" value={keyName} onChange={(e) => setKeyName(e.target.value)} className="rounded-md border border-white/10 bg-black/30 px-2 py-1 text-white" />
                    <button type="submit" disabled={busy} className="rounded-md border border-white/20 px-3 py-1 text-white disabled:opacity-50">Create key</button>
                </form>
                {keys.length === 0 ? <p className="text-[var(--muted)]">No keys yet.</p> : (
                    <div className="overflow-x-auto"><table className="w-full text-left">
                        <thead className="text-[var(--muted)]"><tr><th className="py-1 pr-3">Name</th><th className="py-1 pr-3">Key</th><th className="py-1 pr-3">Last used</th><th className="py-1" /></tr></thead>
                        <tbody>{keys.map((k) => (
                            <tr key={k.id} className="border-t border-white/5">
                                <td className="py-2 pr-3 text-white">{k.name || "—"}</td>
                                <td className="py-2 pr-3 font-mono text-xs">{k.prefix ? `${k.prefix}…` : k.id.slice(0, 8)}</td>
                                <td className="py-2 pr-3 text-[var(--muted)]">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}</td>
                                <td className="py-2 text-right">{k.revoked_at ? <span className="text-[var(--muted)]">revoked</span> : <button type="button" onClick={() => revoke(k.id)} disabled={busy} className="text-red-300 hover:underline">Revoke</button>}</td>
                            </tr>
                        ))}</tbody>
                    </table></div>
                )}
            </section>

            <section className={card}>
                <h2 className="mb-3 font-semibold text-white">Recent batches</h2>
                {batches.length === 0 ? <p className="text-[var(--muted)]">No batches yet. Submit one with <code>infernet batch submit file.jsonl --max-cost 0.50</code> or the API.</p> : (
                    <div className="overflow-x-auto"><table className="w-full text-left">
                        <thead className="text-[var(--muted)]"><tr><th className="py-1 pr-3">Created</th><th className="py-1 pr-3">Model</th><th className="py-1 pr-3">Status</th><th className="py-1 pr-3">Cost</th><th className="py-1">Cap</th></tr></thead>
                        <tbody>{batches.map((b) => (
                            <tr key={b.id} className="border-t border-white/5">
                                <td className="py-2 pr-3 text-[var(--muted)]">{new Date(b.created_at).toLocaleString()}</td>
                                <td className="py-2 pr-3 text-white">{b.model}</td>
                                <td className="py-2 pr-3">{b.cancelling ? "cancelling" : b.status}</td>
                                <td className="py-2 pr-3 text-white">{usd(b.cost_so_far_usd)}</td>
                                <td className="py-2">{usd(b.max_cost_usd)}</td>
                            </tr>
                        ))}</tbody>
                    </table></div>
                )}
            </section>
        </div>
    );
}
