"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { recommendModels, vramFromSpecs, USE_CASES, CATALOG } from "@/lib/model-catalog";

/**
 * Per-node model management button on the dashboard.
 *
 * Shows three sections:
 *   Recommendations — top picks for this node's VRAM, filtered by use case
 *   Install         — free-text input → model_install command (power users)
 *   Installed       — list of currently served models → model_remove
 *
 * Commands are queued via POST /api/v1/user/nodes/<pubkey>/commands and
 * picked up by the daemon's poll loop within ~30s.
 */
export default function PushModelButton({ pubkey, servedModels = [], specs }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [model, setModel] = useState("qwen2.5:7b");
    const [submitting, setSubmitting] = useState(false);
    const [removing, setRemoving] = useState(null);
    const [cancelling, setCancelling] = useState(null);
    const [error, setError] = useState(null);
    const [commands, setCommands] = useState([]);
    const [loadingCommands, setLoadingCommands] = useState(false);
    const [useCase, setUseCase] = useState(null);

    // Compute hardware-aware recommendations from this node's reported specs.
    // Privacy-sanitized telemetry only carries vram_tier strings, mapped to
    // representative GB inside vramFromSpecs.
    const vramGb = useMemo(() => vramFromSpecs(specs), [specs]);
    // Show the top three hardware-aware picks for the selected use case.
    const recommendations = useMemo(
        () => recommendModels({ vramGb, useCase, limit: 3 }),
        [vramGb, useCase]
    );

    // Portal the modal to document.body so it escapes the table's stacking
    // context. Position it relative to the trigger button via a ref + the
    // button's bounding rect.
    const triggerRef = useRef(null);
    const [portalReady, setPortalReady] = useState(false);
    const [pos, setPos] = useState({ top: 0, right: 0 });

    useEffect(() => { setPortalReady(true); }, []);

    useLayoutEffect(() => {
        if (!open || !triggerRef.current) return;
        const update = () => {
            const r = triggerRef.current?.getBoundingClientRect();
            if (!r) return;
            setPos({
                top:   r.bottom + 6,
                right: Math.max(8, window.innerWidth - r.right)
            });
        };
        update();
        window.addEventListener("scroll", update, true);
        window.addEventListener("resize", update);
        return () => {
            window.removeEventListener("scroll", update, true);
            window.removeEventListener("resize", update);
        };
    }, [open]);

    async function refresh() {
        if (!open) return;
        setLoadingCommands(true);
        try {
            const res = await fetch(`/api/v1/user/nodes/${encodeURIComponent(pubkey)}/commands?limit=10`);
            if (res.ok) {
                const body = await res.json();
                setCommands(body?.data ?? []);
            }
        } catch { /* ignore */ }
        setLoadingCommands(false);
    }

    useEffect(() => {
        if (!open) return;
        refresh();
        const inFlight = (cs) => cs.some((c) => c.status === "pending" || c.status === "running");
        const tick = () => { if (inFlight(commands)) refresh(); };
        // Tight 2s poll while a pull is running so the progress bar
        // tracks closely with what the daemon reports (it posts at most
        // every 2s too — see ollamaPullWithProgress in start.js).
        const id = setInterval(tick, 2000);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, commands.length]);

    async function submit(e) {
        e?.preventDefault?.();
        setError(null);
        setSubmitting(true);
        try {
            // Send the model's HF repo (if the catalog has one) so a GPU node
            // serves it on vLLM; the node falls back to the Ollama tag when it
            // has no vLLM. Free-text `hf:` names carry their own repo.
            const entry = CATALOG.find((m) => m.pull === model);
            const installArgs = entry?.hf ? { model, hf: entry.hf } : { model };
            const res = await fetch(`/api/v1/user/nodes/${encodeURIComponent(pubkey)}/commands`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ command: "model_install", args: installArgs })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setCommands((prev) => [body.data, ...prev]);
            router.refresh();
        } catch (err) {
            setError(err?.message ?? String(err));
        } finally {
            setSubmitting(false);
        }
    }

    async function cancelCommand(id) {
        setError(null);
        setCancelling(id);
        try {
            const res = await fetch(
                `/api/v1/user/nodes/${encodeURIComponent(pubkey)}/commands/${encodeURIComponent(id)}`,
                { method: "DELETE" }
            );
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            // Optimistically mark it cancelled in the list; the poll will confirm.
            setCommands((prev) => prev.map((c) => (c.id === id ? { ...c, status: "cancelled" } : c)));
            router.refresh();
        } catch (err) {
            setError(err?.message ?? String(err));
        } finally {
            setCancelling(null);
        }
    }

    async function removeModel(name) {
        setError(null);
        setRemoving(name);
        try {
            const res = await fetch(`/api/v1/user/nodes/${encodeURIComponent(pubkey)}/commands`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ command: "model_remove", args: { model: name } })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            setCommands((prev) => [body.data, ...prev]);
            router.refresh();
        } catch (err) {
            setError(err?.message ?? String(err));
        } finally {
            setRemoving(null);
        }
    }

    const trigger = (
        <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-md border border-white/15 bg-[var(--panel-strong)] px-2.5 py-1 text-xs text-white hover:bg-white/10"
        >
            Models
        </button>
    );

    if (!open || !portalReady) {
        return trigger;
    }

    const modal = (
        <div
            className="fixed z-[100] w-[min(24rem,90vw)] rounded-[1rem] border border-white/15 bg-[var(--panel)] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur"
            style={{ top: pos.top, right: pos.right }}
        >
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Manage models</h3>
                <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Close"
                    className="rounded p-1 text-[var(--muted)] hover:text-white"
                >
                    ✕
                </button>
            </div>

            {/* Recommendations — hardware-aware, filterable by use case */}
            <div className="mt-3">
                <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                        Models · best fit first {vramGb > 0 ? `· ~${vramGb} GB VRAM` : "· no GPU detected"}
                    </p>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                    {USE_CASES.map((uc) => (
                        <button
                            key={uc.id ?? "any"}
                            type="button"
                            onClick={() => setUseCase(uc.id)}
                            className={`rounded-full border px-2 py-0.5 text-[10px] ${
                                useCase === uc.id
                                    ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]"
                                    : "border-white/10 bg-[var(--panel-strong)] text-[var(--muted)] hover:text-white"
                            }`}
                        >
                            {uc.label}
                        </button>
                    ))}
                </div>
                <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1">
                    {recommendations.map((rec) => {
                        const m = rec.model;
                        const isSelected = model === m.pull;
                        return (
                            <li key={m.id}>
                                <button
                                    type="button"
                                    onClick={() => setModel(m.pull)}
                                    className={`flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition ${
                                        isSelected
                                            ? "border-[var(--accent)] bg-[var(--accent)]/10"
                                            : rec.fits
                                            ? "border-white/10 bg-[var(--panel-strong)] hover:border-white/25"
                                            : "border-white/5 bg-[var(--panel-strong)]/40 opacity-60 hover:opacity-90"
                                    }`}
                                    title={m.pull}
                                >
                                    <div className="min-w-0">
                                        <div className="truncate text-white">{m.name}</div>
                                        <div className="truncate text-[10px] text-[var(--muted)]">
                                            {m.paramsB}B · ≥{m.vramMin}GB VRAM · {m.backend}
                                            {!rec.fits && " · ⚠ tight"}
                                        </div>
                                    </div>
                                </button>
                            </li>
                        );
                    })}
                    {recommendations.length === 0 && (
                        <li className="text-xs text-[var(--muted)]">
                            No models match. Try a different use case.
                        </li>
                    )}
                </ul>
            </div>

            {/* Install section */}
            <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Install</p>
            <form onSubmit={submit} className="mt-1.5 space-y-3">
                <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="qwen2.5:7b or hf:org/repo"
                    className="block w-full rounded-md border border-white/10 bg-[var(--panel-strong)] px-3 py-2 text-sm text-white outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30"
                />
                <button
                    type="submit"
                    disabled={submitting || !model.trim()}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-strong)] px-4 py-2 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)] disabled:opacity-40"
                >
                    {submitting ? "Queueing…" : "Push install"}
                </button>
            </form>

            {/* Installed models section */}
            {servedModels.length > 0 && (
                <div className="mt-4 border-t border-white/10 pt-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Installed on node</p>
                    <ul className="mt-2 space-y-1.5">
                        {servedModels.map((name) => (
                            <li key={name} className="flex items-center justify-between gap-3">
                                <span className="truncate text-xs text-white">{name}</span>
                                <button
                                    type="button"
                                    disabled={removing === name}
                                    onClick={() => removeModel(name)}
                                    className="shrink-0 rounded border border-red-400/30 bg-red-400/10 px-2 py-0.5 text-[10px] text-red-200 hover:bg-red-400/20 disabled:opacity-40"
                                >
                                    {removing === name ? "…" : "remove"}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {error ? (
                <p className="mt-3 rounded-md border border-red-400/30 bg-red-400/10 p-2 text-xs text-red-200">
                    {error}
                </p>
            ) : null}

            {/* Recent commands */}
            <div className="mt-4 border-t border-white/10 pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
                    Recent commands {loadingCommands ? "(refreshing…)" : ""}
                </p>
                {commands.length === 0 ? (
                    <p className="mt-2 text-xs text-[var(--muted)]">
                        Nothing queued yet. Daemon polls every ~30s.
                    </p>
                ) : (
                    <ul className="mt-2 space-y-1.5 text-xs">
                        {commands.map((c) => (
                            <li key={c.id}>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="truncate text-white">
                                        {c.command === "model_install" ? "+" : c.command === "model_remove" ? "−" : "?"}{" "}
                                        {c.args?.model ?? "—"}
                                    </span>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <CommandStatus s={c.status} />
                                        {c.status === "pending" || c.status === "running" ? (
                                            <button
                                                type="button"
                                                onClick={() => cancelCommand(c.id)}
                                                disabled={cancelling === c.id}
                                                className="rounded border border-red-400/30 bg-red-400/10 px-1.5 py-0.5 text-[10px] text-red-200 hover:bg-red-400/20 disabled:opacity-50"
                                            >
                                                {cancelling === c.id ? "…" : "Cancel"}
                                            </button>
                                        ) : null}
                                    </div>
                                </div>
                                {c.progress || c.status === "running" ? (
                                    <StepBar progress={c.progress} status={c.status} />
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
                {/* Only surface the error from the MOST RECENT command. Old
                    failures stay in the list as visual history but their
                    stale error text doesn't shadow new actions — pushing a
                    new model effectively clears the displayed error since
                    commands[0] becomes the new pending row. */}
                {commands[0]?.error ? (
                    <p className="mt-2 rounded-md border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-100">
                        {commands[0].error}
                    </p>
                ) : null}
            </div>
        </div>
    );

    return (
        <>
            {trigger}
            {createPortal(modal, document.body)}
        </>
    );
}

function ProgressBar({ progress }) {
    const pct = Number.isFinite(progress?.pct)
        ? Math.max(0, Math.min(100, progress.pct))
        : null;
    const status = progress?.status ?? "working…";
    const total = progress?.total;
    const completed = progress?.completed;
    const sizeBlurb = (Number.isFinite(total) && total > 0)
        ? ` · ${formatBytes(completed ?? 0)} / ${formatBytes(total)}`
        : "";
    return (
        <div className="mt-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                    className="h-full bg-[var(--accent)] transition-all duration-500"
                    style={{ width: `${pct ?? 5}%` }}
                />
            </div>
            <p className="mt-0.5 text-[10px] text-[var(--muted)]">
                {status}{pct != null ? ` · ${pct}%` : ""}{sizeBlurb}
            </p>
        </div>
    );
}

// Labels for a stepped install. Keyed by step count so the bar reads
// "download | load engine | serve" for a 3-step vLLM install.
const STEP_LABELS = { 3: ["download", "load engine", "serve"], 2: ["download", "serve"] };

/**
 * Segmented progress bar: one segment per step, filled left-to-right as the
 * install advances (download → load → serve), until the whole thing is
 * finished / failed / cancelled. Falls back to the plain bar when the daemon
 * didn't send stepped info (e.g. an Ollama pull).
 */
function StepBar({ progress, status }) {
    const steps = Number.isFinite(progress?.steps) ? progress.steps : null;
    if (!steps || steps < 2) return <ProgressBar progress={progress} />;

    const cur = Number.isFinite(progress?.step) ? progress.step : 1;
    const pct = Number.isFinite(progress?.pct) ? Math.max(0, Math.min(100, progress.pct)) : 0;
    const done = status === "completed";
    const failed = status === "failed";
    const cancelled = status === "cancelled";
    const labels = STEP_LABELS[steps] ?? Array.from({ length: steps }, (_, i) => `step ${i + 1}`);

    return (
        <div className="mt-1">
            <div className="flex gap-1">
                {Array.from({ length: steps }, (_, i) => {
                    const idx = i + 1;
                    let fill = 0;
                    if (done || idx < cur) fill = 100;
                    else if (idx === cur) fill = (failed || cancelled) ? 100 : pct;
                    const color =
                        done || idx < cur ? "bg-emerald-400" :
                        (failed && idx === cur) ? "bg-red-400" :
                        (cancelled && idx === cur) ? "bg-white/25" :
                        "bg-[var(--accent)]";
                    return (
                        <div key={i} className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                            <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${fill}%` }} />
                        </div>
                    );
                })}
            </div>
            <p className="mt-0.5 text-[10px] text-[var(--muted)]">
                {cancelled ? "cancelled"
                    : failed ? "failed"
                    : done ? "done"
                    : (labels[cur - 1] ?? progress?.status ?? "working…")}
                {!done && !failed && !cancelled && pct ? ` · ${pct}%` : ""}
                {` · step ${Math.min(cur, steps)}/${steps}`}
            </p>
        </div>
    );
}

function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function CommandStatus({ s }) {
    const tone =
        s === "completed" ? "bg-emerald-400/15 text-emerald-200 border-emerald-400/30" :
        s === "failed"    ? "bg-red-400/15 text-red-200 border-red-400/30" :
        s === "cancelled" ? "bg-white/10 text-[var(--muted)] border-white/15 line-through" :
        s === "running"   ? "bg-amber-400/15 text-amber-100 border-amber-400/30" :
                            "bg-white/5 text-[var(--muted)] border-white/10";
    return (
        <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] ${tone}`}>
            {s ?? "?"}
        </span>
    );
}
