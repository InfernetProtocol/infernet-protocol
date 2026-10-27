"use client";

import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "infernet-admin-token";
const MIN = 1;
const MAX = 2000;
const STEPS = 1000;

function readToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}
function saveToken(t) {
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

// The slider is logarithmic so 1%..100% gets as much travel as 100%..2000%.
const toPct = (pos) => Math.round(Math.exp(Math.log(MIN) + (Math.log(MAX) - Math.log(MIN)) * (pos / STEPS)));
const toPos = (pct) => Math.round(((Math.log(Math.min(MAX, Math.max(MIN, pct))) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN))) * STEPS);
// Same as lib/reservations/margin.js priceFromCost.
const priceAt = (cost, pct) => Math.ceil(Math.round(cost * (1 + pct / 100) * 1e6) / 1e6 * 100) / 100;

/**
 * /admin/pricing client: the minimum profit margin self-serve orders sell at
 * over our GPU cost, as a slider (1%..2000%) with a live price preview.
 */
export default function AdminOrderPricing() {
    const [token, setToken] = useState("");
    const [view, setView] = useState(null);
    const [pct, setPct] = useState(100);
    const [error, setError] = useState(null);
    const [saved, setSaved] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => { setToken(readToken()); }, []);

    const call = useCallback(async (init = {}) => {
        const res = await fetch("/api/v1/admin/orders/pricing", {
            ...init,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        return json.data;
    }, [token]);

    useEffect(() => {
        if (!token) return;
        call().then((v) => { setView(v); setPct(v.min_margin_pct); }).catch((e) => setError(e.message));
    }, [call, token]);

    async function save(event) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const v = await call({ method: "POST", body: JSON.stringify({ min_margin_pct: pct }) });
            setView(v);
            setPct(v.min_margin_pct);
            setSaved(v.min_margin_pct);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
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

    return (
        <form onSubmit={save} className="space-y-6 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
            {error ? <p className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p> : null}
            <div>
                <label htmlFor="margin" className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--muted)]">Minimum profit margin</label>
                <div className="mt-3 flex flex-wrap items-center gap-4">
                    <input id="margin" type="range" min={0} max={STEPS} value={toPos(pct)}
                        onChange={(e) => setPct(toPct(Number(e.target.value)))}
                        className="w-full max-w-xl accent-[var(--accent)]" />
                    <input type="number" min={MIN} max={MAX} step={1} value={pct} aria-label="Margin percent"
                        onChange={(e) => setPct(Math.min(MAX, Math.max(MIN, Number(e.target.value) || MIN)))}
                        className="w-28 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-white" />
                    <span className="text-white">%</span>
                    <button type="button" onClick={() => setPct(100)} className="rounded-full border border-white/15 px-3 py-1 text-xs text-[var(--muted)]">reset to 100%</button>
                </div>
                <p className="mt-2 text-xs text-[var(--muted)]">Orders sell at our GPU cost x (1 + margin). 100% = twice our cost. Range {MIN}% to {MAX}%. Applies to new quotes only; paid orders keep their price.</p>
            </div>
            {view ? (
                <table className="w-full max-w-2xl border-collapse text-sm">
                    <thead>
                        <tr className="text-left text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                            <th className="py-2 pr-3 font-medium">Class</th>
                            <th className="py-2 pr-3 font-medium">Our cost /h</th>
                            <th className="py-2 pr-3 font-medium">Price /h at {pct}%</th>
                            <th className="py-2 pr-3 font-medium">Setup fee</th>
                        </tr>
                    </thead>
                    <tbody>
                        {view.classes.map((c) => {
                            const p = priceAt(c.cost_per_hour, pct);
                            return (
                                <tr key={c.gpu_class} className="border-t border-white/5">
                                    <td className="py-2 pr-3 text-white">{c.label}</td>
                                    <td className="py-2 pr-3 text-[var(--muted)]">${c.cost_per_hour.toFixed(2)}</td>
                                    <td className="py-2 pr-3 text-white">${p.toFixed(2)}</td>
                                    <td className="py-2 pr-3 text-[var(--muted)]">${(5 + p).toFixed(2)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            ) : null}
            <div className="flex items-center gap-3">
                <button type="submit" disabled={busy || pct === view?.min_margin_pct}
                    className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black disabled:opacity-50">Save margin</button>
                <span className="text-xs text-[var(--muted)]">live: {view?.min_margin_pct ?? "…"}%{saved != null ? ` (saved ${saved}%)` : ""}</span>
                <button type="button" onClick={() => { saveToken(""); setToken(""); }}
                    className="ml-auto rounded-full border border-white/15 px-3 py-1 text-xs text-[var(--muted)]">lock</button>
            </div>
        </form>
    );
}
