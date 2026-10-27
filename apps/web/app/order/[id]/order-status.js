"use client";

import { useEffect, useState } from "react";
import CopyButton from "@/components/copy-button";

/**
 * The checkout return page. The buyer token rides in the URL fragment (never
 * sent to a server log) or in localStorage from the order form; the page
 * polls the order until CoinPay confirms and the reservation exists.
 */
export default function OrderStatus({ id }) {
    const [token, setToken] = useState(null);
    const [order, setOrder] = useState(null);
    const [error, setError] = useState(null);
    const [key, setKey] = useState(null);

    useEffect(() => {
        const fromHash = new URLSearchParams(window.location.hash.slice(1)).get("token");
        let t = fromHash;
        try {
            if (fromHash) localStorage.setItem(`infernet-order:${id}`, fromHash);
            t = t || localStorage.getItem(`infernet-order:${id}`);
        } catch { /* private mode */ }
        if (!t) setError("This link has no buyer token. Open the link from your checkout receipt on the device you ordered from.");
        setToken(t);
    }, [id]);

    useEffect(() => {
        if (!token) return undefined;
        let stop = false;
        async function poll() {
            try {
                const res = await fetch(`/api/v1/orders/${id}`, { headers: { "x-buyer-token": token } });
                const body = await res.json();
                if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
                setOrder(body.data);
                if (body.data.status === "awaiting_payment" && !stop) setTimeout(poll, 5000);
            } catch (e) {
                setError(e?.message ?? String(e));
            }
        }
        poll();
        return () => { stop = true; };
    }, [id, token]);

    async function issueKey() {
        setError(null);
        try {
            const res = await fetch(`/api/v1/reservations/${order.reservation_id}/keys`, {
                method: "POST",
                headers: { "x-buyer-token": token, "content-type": "application/json" },
                body: JSON.stringify({ label: "web" })
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setKey(body.data.key);
        } catch (e) {
            setError(e?.message ?? String(e));
        }
    }

    const panel = "mb-6 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6 backdrop-blur";
    return (
        <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:px-10">
            <h1 className="mb-6 text-3xl font-semibold tracking-tight text-white">Your order</h1>
            {error ? <p className="mb-6 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p> : null}
            {order ? (
                <section className={panel}>
                    <p className="text-sm text-[var(--muted)]">Order <span className="font-mono text-white">{order.id}</span></p>
                    <p className="mt-2 text-lg text-white">
                        {order.status === "fulfilled" ? "Booked." : order.status === "awaiting_payment" ? "Waiting for CoinPay to confirm the payment…" : `Status: ${order.status}`}
                    </p>
                    <p className="mt-2 text-sm text-[var(--muted)]">
                        {order.gpu_class} · {order.models.join(", ")} · {order.hours}h from {order.start_at} · ${order.total_usd.toFixed(2)} · operator {order.operator_name}
                    </p>
                    {order.status === "fulfilled" ? (
                        <div className="mt-4 space-y-3 text-sm text-[var(--muted)]">
                            <p>Your buyer token reads the reservation, its compliance report and invoice, and issues API keys. Keep it.</p>
                            <div className="flex items-center gap-2"><code className="break-all text-white">{token}</code><CopyButton text={token} /></div>
                            {key ? (
                                <div className="flex items-center gap-2"><code className="break-all text-white">{key}</code><CopyButton text={key} /></div>
                            ) : (
                                <button type="button" onClick={issueKey} className="inline-flex rounded-full bg-[var(--accent-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--bg)] hover:bg-[var(--accent)]">Issue an API key</button>
                            )}
                            <p>Use it as <code>Authorization: Bearer</code> on <code>{typeof window !== "undefined" ? window.location.origin : ""}/v1/chat/completions</code> during the booked hours.</p>
                        </div>
                    ) : null}
                </section>
            ) : null}
        </main>
    );
}
