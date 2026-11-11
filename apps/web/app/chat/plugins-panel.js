"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export { describePlugins, parsePluginCommand } from "@/lib/plugins/commands";

/*
 * Chat plugins in the browser: the panel (catalog one-click Add, add by URL,
 * on/off, sign in, remove), the /plugin commands, and the cards a plugin turn
 * draws (tool calls with their results, approval cards for destructive calls).
 *
 * Sign-in opens the plugin's own page in a popup. The callback page posts back
 * to this window; if the provider cut the opener (COOP), we also poll until the
 * plugin shows as connected.
 */

async function api(path, init) {
  const res = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { status: res.status });
  return body?.data ?? body;
}

export function usePlugins() {
  const [plugins, setPlugins] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [signedIn, setSignedIn] = useState(null); // null = unknown yet
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api("/api/v1/plugins");
      setPlugins(d.plugins ?? []);
      setCatalog(d.catalog ?? []);
      setSignedIn(true);
      return d.plugins ?? [];
    } catch (e) {
      if (e.status === 401) setSignedIn(false);
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
    function onMessage(ev) {
      if (ev.origin !== window.location.origin || ev.data?.type !== "infernet-plugin") return;
      if (!ev.data.ok && ev.data.message) setError(ev.data.message);
      refresh();
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const openSignIn = useCallback((slug, existing) => {
    const target = `/api/v1/plugins/${encodeURIComponent(slug)}/connect?return=/chat`;
    let w = existing && !existing.closed ? existing : null;
    if (w) w.location.href = target;
    else w = window.open(target, "plugin-signin", "popup,width=520,height=720");
    // Never navigate this tab away (the conversation would be lost).
    if (!w) setError("Your browser blocked the sign-in window. Click Sign in next to the plugin.");
    if (pollRef.current) clearInterval(pollRef.current);
    const started = Date.now();
    pollRef.current = setInterval(async () => {
      const list = await refresh();
      const p = list?.find((x) => x.slug === slug);
      if ((p && p.connected) || Date.now() - started > 5 * 60 * 1000) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 3000);
  }, [refresh]);

  const add = useCallback(async (input) => {
    setError(null);
    setBusy(`add:${input}`);
    // Open the sign-in window now, while we still have the click: a popup opened
    // after the request returns is blocked. Closed again if no sign-in is needed.
    let pop = null;
    try { pop = window.open("about:blank", "plugin-signin", "popup,width=520,height=720"); } catch { pop = null; }
    try {
      const r = await api("/api/v1/plugins", { method: "POST", body: JSON.stringify({ url: input }) });
      await refresh();
      if (r.plugin?.needs_sign_in) openSignIn(r.plugin.slug, pop);
      else pop?.close();
      return r;
    } catch (e) {
      pop?.close();
      setError(e.message);
      throw e;
    } finally {
      setBusy(null);
    }
  }, [refresh, openSignIn]);

  const remove = useCallback(async (slug) => {
    setError(null);
    setBusy(`rm:${slug}`);
    try {
      const r = await api(`/api/v1/plugins/${encodeURIComponent(slug)}`, { method: "DELETE" });
      await refresh();
      return r;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const toggle = useCallback(async (slug, enabled) => {
    setError(null);
    try {
      const r = await api(`/api/v1/plugins/${encodeURIComponent(slug)}/toggle`, { method: "POST", body: JSON.stringify(typeof enabled === "boolean" ? { enabled } : {}) });
      await refresh();
      return r;
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }, [refresh]);

  const enabled = plugins.filter((p) => p.enabled && !p.needs_sign_in);
  return { plugins, catalog, signedIn, error, setError, busy, refresh, add, remove, toggle, openSignIn, enabledCount: enabled.length };
}

export function PluginsPanel({ state, onClose }) {
  const { plugins, catalog, signedIn, error, busy, add, remove, toggle, openSignIn, setError } = state;
  const [url, setUrl] = useState("");
  const installed = new Set(plugins.map((p) => p.url.replace(/\/+$/, "")));

  return (
    <section aria-label="Plugins" className="rounded-[2rem] border border-white/10 bg-[var(--panel)] p-5 shadow-[0_20px_80px_rgba(0,0,0,0.25)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Plugins</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Plugins are MCP servers the model can use while it answers. Add one with a click or a URL; if it asks you to sign in, a window opens on its own site. Turns with plugins on are not end-to-end encrypted, because the server runs the tools.
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-full border border-[var(--line)] px-3 py-1 text-xs text-[var(--muted)] hover:text-white">Close</button>
      </div>

      {signedIn === false ? (
        <p className="mt-4 text-sm text-[var(--muted)]">
          <a href="/auth/login?next=/chat" className="text-[var(--accent)] hover:underline">Sign in</a> to add plugins.
        </p>
      ) : (
        <>
          {error ? (
            <p className="mt-3 rounded-xl border border-[var(--warn)]/40 bg-[var(--warn)]/10 px-3 py-2 text-xs text-[var(--warn)]">
              {error} <button type="button" className="ml-2 underline" onClick={() => setError(null)}>dismiss</button>
            </p>
          ) : null}

          {plugins.length ? (
            <ul className="mt-4 divide-y divide-white/10 rounded-xl border border-white/10">
              {plugins.map((p) => (
                <li key={p.slug} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white">{p.name} <span className="text-xs text-[var(--muted)]">/{p.slug}</span></p>
                    <p className="truncate text-xs text-[var(--muted)]" title={p.url}>
                      {p.needs_sign_in ? "Sign in to use it" : `${p.tools.length} tool${p.tools.length === 1 ? "" : "s"}`}
                      {p.last_error ? ` · ${p.last_error}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.can_sign_in ? (
                      <button type="button" onClick={() => openSignIn(p.slug)} className="rounded-full bg-[var(--accent-strong)] px-3 py-1 text-xs font-medium text-black">
                        Sign in
                      </button>
                    ) : null}
                    <label className="flex items-center gap-1 text-xs text-[var(--muted)]">
                      <input type="checkbox" checked={p.enabled} onChange={(e) => toggle(p.slug, e.target.checked)} className="accent-[var(--accent)]" />
                      On
                    </label>
                    <button type="button" onClick={() => remove(p.slug)} disabled={busy === `rm:${p.slug}`} className="rounded-full border border-[var(--line)] px-3 py-1 text-xs text-[var(--muted)] hover:text-white disabled:opacity-50">
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          <h3 className="mt-5 text-xs uppercase tracking-[0.25em] text-[var(--muted)]">Catalog</h3>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {catalog.map((c) => {
              const have = installed.has(c.url.replace(/\/+$/, ""));
              return (
                <li key={c.slug} className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/15 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-white">{c.name}</p>
                    {c.description ? <p className="text-xs text-[var(--muted)]">{c.description}</p> : null}
                  </div>
                  <button
                    type="button"
                    disabled={have || busy === `add:${c.slug}`}
                    onClick={() => add(c.slug).catch(() => {})}
                    className="shrink-0 rounded-full bg-[var(--accent-strong)] px-3 py-1 text-xs font-medium text-black disabled:opacity-40"
                  >
                    {have ? "Added" : busy === `add:${c.slug}` ? "Adding…" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>

          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = url.trim();
              if (v) add(v).then(() => setUrl("")).catch(() => {});
            }}
          >
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              aria-label="Plugin URL"
              className="min-w-0 flex-1 rounded-full border border-[var(--line)] bg-[var(--panel-strong)] px-4 py-2 text-sm text-white outline-none placeholder:text-[var(--muted)]/70"
            />
            <button type="submit" disabled={!url.trim() || !!busy} className="rounded-full bg-[var(--accent-strong)] px-4 py-2 text-sm font-medium text-black disabled:opacity-40">
              Add
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function prettyArgs(args) {
  try {
    const s = JSON.stringify(args ?? {}, null, 2);
    return s === "{}" ? "" : s;
  } catch {
    return "";
  }
}

/** One tool call and its result. Text is rendered as text (React escapes it), never as HTML. */
export function ToolCallCard({ call }) {
  const label = call.status === "running" ? "running…" : call.denied ? "declined" : call.isError ? "error" : "done";
  const args = prettyArgs(call.arguments);
  return (
    <details className="my-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs" open={call.status === "running"}>
      <summary className="cursor-pointer text-[var(--muted)]">
        <span className="text-white">{call.title || call.tool}</span>
        <span> · {call.plugin}</span>
        <span className={call.isError && !call.denied ? " text-[var(--warn)]" : ""}> · {label}</span>
      </summary>
      {args ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono">{args}</pre> : null}
      {call.text ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono">{call.text}</pre> : null}
    </details>
  );
}

export function ApprovalCard({ approval, onDecide }) {
  const { call, answered } = approval;
  const args = prettyArgs(call.arguments);
  return (
    <div className="my-2 rounded-xl border border-[var(--warn)]/50 bg-[var(--warn)]/10 px-3 py-3 text-xs">
      <p className="text-sm text-white">
        Allow <strong>{call.pluginName || call.plugin}</strong> to run <strong>{call.title || call.tool}</strong>?
      </p>
      <p className="mt-1 text-[var(--muted)]">This tool can change or delete things on {call.pluginName || call.plugin}.</p>
      {args ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono">{args}</pre> : null}
      {answered ? (
        <p className="mt-2 text-[var(--muted)]">{answered === "allow" ? "Allowed." : "Declined."}</p>
      ) : (
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => onDecide("allow")} className="rounded-full bg-[var(--accent-strong)] px-3 py-1 font-medium text-black">Allow</button>
          <button type="button" onClick={() => onDecide("deny")} className="rounded-full border border-[var(--line)] px-3 py-1 text-[var(--muted)] hover:text-white">Deny</button>
        </div>
      )}
    </div>
  );
}

/** Read an SSE response body and call onEvent for each JSON data line. */
export async function readEventStream(res, onEvent, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal?.aborted) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try { onEvent(JSON.parse(data)); } catch { /* skip a bad frame */ }
    }
  }
}
