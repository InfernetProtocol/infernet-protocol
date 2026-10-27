"use client";

import { useEffect, useState } from "react";

/**
 * Self-serve order form: pick a GPU class and the models, see the price, pay
 * at CoinPay. Agents use POST /api/v1/orders with x402 instead.
 */
export default function OrderView() {
    const [cap, setCap] = useState(null);
    const [error, setError] = useState(null);
    const [gpu, setGpu] = useState("");
    const [models, setModels] = useState([]);
    const [hours, setHours] = useState(1);
    const [email, setEmail] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        fetch("/api/v1/orders/capacity").then((r) => r.json()).then((b) => {
            if (!b?.data) throw new Error(b?.error ?? "capacity lookup failed");
            setCap(b.data);
            const first = b.data.classes.find((c) => c.nodes_available > 0);
            if (first) setGpu(first.gpu_class);
        }).catch((e) => setError(e?.message ?? String(e)));
    }, []);

    const cls = cap?.classes.find((c) => c.gpu_class === gpu) ?? null;
    const total = cls ? Math.round((cls.price_per_hour * hours + cls.setup_fee) * 100) / 100 : null;

    async function order() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch("/api/v1/orders", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ gpu_class: gpu, models, hours: Number(hours), email: email || undefined, pay: "checkout" })
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            // Keep the buyer token on this device too, in case the return link is lost.
            try { localStorage.setItem(`infernet-order:${body.data.order.id}`, body.data.buyer_token); } catch { /* private mode */ }
            window.location.href = body.data.checkout_url;
        } catch (e) {
            setError(e?.message ?? String(e));
            setBusy(false);
        }
    }

    const panel = "mb-6 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6 backdrop-blur";
    return (
        <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:px-10">
            <header className="mb-8 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Order</p>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Book a dedicated model endpoint</h1>
                <p className="max-w-2xl text-sm leading-6 text-[var(--muted)]">
                    Pick a GPU class and the models. We pin them on one online node for the hours you book and give you an
                    OpenAI-compatible API key. {cap?.terms}
                </p>
            </header>

            {error ? <p className="mb-6 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p> : null}
            {!cap && !error ? <p className="text-sm text-[var(--muted)]">Checking what is online…</p> : null}

            {cap ? (
                <section className={panel}>
                    <h2 className="text-lg font-semibold text-white">1. GPU class</h2>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        {cap.classes.map((c) => (
                            <button
                                key={c.gpu_class}
                                type="button"
                                disabled={c.nodes_available === 0}
                                onClick={() => { setGpu(c.gpu_class); setModels([]); }}
                                className={`rounded-xl border p-4 text-left transition disabled:opacity-40 ${gpu === c.gpu_class ? "border-[var(--accent)] bg-white/5" : "border-white/10 hover:border-white/30"}`}
                            >
                                <div className="font-semibold text-white">{c.label}</div>
                                <div className="text-xs text-[var(--muted)]">{c.fits}</div>
                                <div className="mt-2 text-sm text-white">${c.price_per_hour.toFixed(2)}/h + ${c.setup_fee.toFixed(2)} setup</div>
                                <div className="text-xs text-[var(--muted)]">{c.nodes_available ? `${c.nodes_available} node${c.nodes_available > 1 ? "s" : ""} free` : "none online right now"}</div>
                            </button>
                        ))}
                    </div>
                    {cap.classes.every((c) => c.nodes_available === 0) ? (
                        <p className="mt-4 text-sm text-amber-100">
                            No node with these GPUs is online right now, so nothing can be booked. Operators: run a node with
                            one of these cards and it goes on sale here automatically.
                        </p>
                    ) : null}
                </section>
            ) : null}

            {cls && cls.nodes_available > 0 ? (
                <section className={panel}>
                    <h2 className="text-lg font-semibold text-white">2. Models and hours</h2>
                    <div className="mt-4 flex flex-wrap gap-2">
                        {cls.models.map((m) => (
                            <label key={m} className="flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-sm text-white">
                                <input type="checkbox" checked={models.includes(m)}
                                    onChange={(e) => setModels(e.target.checked ? [...models, m] : models.filter((x) => x !== m))} />
                                <span className="font-mono">{m}</span>
                            </label>
                        ))}
                    </div>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        <label className="text-sm text-[var(--muted)]">Hours (from {new Date(cap.earliest_start).toUTCString()})
                            <input type="number" min={1} max={cap.max_hours} value={hours} onChange={(e) => setHours(e.target.value)}
                                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white" />
                        </label>
                        <label className="text-sm text-[var(--muted)]">Email for the receipt (optional)
                            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white" />
                        </label>
                    </div>
                    <div className="mt-6 flex items-center justify-between gap-4">
                        <div className="text-white">Total <span className="font-semibold">${total?.toFixed(2)}</span> <span className="text-xs text-[var(--muted)]">prepaid</span></div>
                        <button type="button" onClick={order} disabled={busy || models.length === 0 || !(Number(hours) >= 1)}
                            className="inline-flex rounded-full bg-[var(--accent-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)] disabled:opacity-40">
                            {busy ? "Opening checkout…" : "Pay with CoinPay"}
                        </button>
                    </div>
                </section>
            ) : null}

            <section className={panel}>
                <h2 className="text-lg font-semibold text-white">Agents, CLI and MCP</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                    <code>POST /api/v1/orders</code> answers 402 with an x402 offer (USDC on Base, Polygon or Ethereum); retry with the
                    payment and get the reservation and an API key back in one call. From a terminal: <code>infernet order</code>.
                    From an agent: the <code>order_create</code> tool in <code>infernet mcp</code>.
                </p>
            </section>
        </main>
    );
}
