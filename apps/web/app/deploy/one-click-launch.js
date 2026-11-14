"use client";

import { useState } from "react";

const PROVIDERS = [
    { id: "vast", label: "Vast.ai", keyUrl: "https://cloud.vast.ai/manage-keys/", hint: "Cheapest consumer GPUs (4090/3090). Your key is needed to search live offers." },
    { id: "linode", label: "Linode / Akamai", keyUrl: "https://cloud.linode.com/profile/tokens", hint: "RTX 4000 Ada / RTX 6000 VMs. Token scope: Linodes read/write." },
    { id: "vultr", label: "Vultr", keyUrl: "https://my.vultr.com/settings/#settingsapi", hint: "L40S VMs. Only regions with stock are offered." },
    { id: "digitalocean", label: "DigitalOcean", keyUrl: "https://cloud.digitalocean.com/account/api/tokens", hint: "H100 / L40S droplets. Token scope: write." }
];

/**
 * One-click launch on the operator's own cloud account. The API key
 * lives in this component's state only (no storage), goes to our
 * server over HTTPS for the one request, and is never stored there.
 */
export default function OneClickLaunch() {
    const [provider, setProvider] = useState("vast");
    const [apiKey, setApiKey] = useState("");
    const [offers, setOffers] = useState(null);
    const [regions, setRegions] = useState({});
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);
    const [launched, setLaunched] = useState(null);

    const meta = PROVIDERS.find((p) => p.id === provider);

    async function post(body) {
        const res = await fetch("/api/v1/user/deploy/one-click", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider, apiKey, ...body })
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
        return json.data;
    }

    async function findOffers() {
        setError(null); setOffers(null); setLaunched(null); setBusy("offers");
        try {
            const data = await post({ action: "offers" });
            setOffers(data.offers);
            const firstRegions = {};
            for (const o of data.offers) if (o.regions?.length) firstRegions[o.id] = o.regions[0];
            setRegions(firstRegions);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(null);
        }
    }

    async function launchOffer(offer) {
        const region = regions[offer.id];
        const where = provider === "vast" ? offer.label : `${offer.id} in ${region}`;
        if (!window.confirm(`Rent ${where} at $${offer.pricePerHour.toFixed(3)}/hr on YOUR ${meta.label} account?\n\nIt bills until you destroy it at ${meta.label}.`)) return;
        setError(null); setBusy(offer.id);
        try {
            setLaunched(await post({ action: "launch", offerId: offer.id, region }));
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className="mb-8 rounded-[1.5rem] border border-[var(--accent)]/40 bg-[var(--panel)] p-6 backdrop-blur">
            <h2 className="text-lg font-semibold text-white">One-click launch</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
                Pick a cloud, paste its API key, click Launch. We rent the GPU on <em>your</em> account (you pay the cloud
                directly), boot it with a fresh 24h deploy token, and the node links itself to this Infernet account.
                The key is used for that request only and never stored.
            </p>

            <div className="mt-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Cloud provider">
                {PROVIDERS.map((p) => (
                    <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={provider === p.id}
                        onClick={() => { setProvider(p.id); setOffers(null); setLaunched(null); setError(null); setApiKey(""); }}
                        className={`rounded-full border px-4 py-1.5 text-sm transition ${provider === p.id ? "border-[var(--accent)] bg-[var(--accent)]/15 text-white" : "border-white/15 text-[var(--muted)] hover:text-white"}`}
                    >
                        {p.label}
                    </button>
                ))}
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">{meta.hint}</p>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={`${meta.label} API key`}
                    aria-label={`${meta.label} API key`}
                    className="min-w-0 flex-1 rounded-lg border border-white/15 bg-[var(--panel-strong)] px-3 py-2 font-mono text-sm text-white placeholder:text-white/30"
                />
                <button
                    type="button"
                    onClick={findOffers}
                    disabled={busy !== null || !apiKey}
                    className="shrink-0 rounded-full bg-[var(--accent-strong)] px-5 py-2 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)] disabled:opacity-40"
                >
                    {busy === "offers" ? "Searching…" : "Find GPUs"}
                </button>
            </div>
            <p className="mt-1 text-xs text-[var(--muted)]">
                No key yet? <a href={meta.keyUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">Create one at {meta.label}</a>.
            </p>

            {error ? (
                <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>
            ) : null}

            {launched ? (
                <p className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                    Launched instance <span className="font-mono">{launched.instanceId}</span>. It boots, installs and registers in a few
                    minutes, then appears on <a href="/dashboard" className="underline">/dashboard</a>. Manage or destroy it at{" "}
                    <a href={launched.consoleUrl} target="_blank" rel="noreferrer" className="underline">{meta.label}</a>.
                </p>
            ) : null}

            {offers ? (
                offers.length === 0 ? (
                    <p className="mt-4 text-sm text-[var(--muted)]">No GPU offers available on {meta.label} right now.</p>
                ) : (
                    <ul className="mt-4 divide-y divide-white/10 rounded-lg border border-white/10">
                        {offers.slice(0, 15).map((o) => {
                            const noStock = provider !== "vast" && !(o.regions?.length);
                            return (
                                <li key={o.id} className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                                    <div className="min-w-0">
                                        <div className="truncate font-medium text-white">
                                            {o.label}{o.vramGb ? ` · ${o.vramGb} GB` : ""}
                                        </div>
                                        <div className="text-xs text-[var(--muted)]">{o.detail}</div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <span className="font-mono text-[var(--accent)]">${o.pricePerHour.toFixed(3)}/hr</span>
                                        {provider !== "vast" && o.regions?.length ? (
                                            <select
                                                value={regions[o.id] ?? ""}
                                                onChange={(e) => setRegions((r) => ({ ...r, [o.id]: e.target.value }))}
                                                aria-label="Region"
                                                className="rounded border border-white/15 bg-[var(--panel-strong)] px-2 py-1 text-xs text-white"
                                            >
                                                {o.regions.map((r) => <option key={r} value={r}>{r}</option>)}
                                            </select>
                                        ) : null}
                                        <button
                                            type="button"
                                            onClick={() => launchOffer(o)}
                                            disabled={busy !== null || noStock}
                                            className="rounded-full border border-[var(--accent)] px-4 py-1 text-xs font-semibold text-white transition hover:bg-[var(--accent)]/20 disabled:opacity-40"
                                        >
                                            {noStock ? "No stock" : busy === o.id ? "Launching…" : "Launch"}
                                        </button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )
            ) : null}
        </section>
    );
}
