import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { endpointApiKey } from "@/lib/data/reservations";

/**
 * The pinned target of a reservation: probing it and talking to it.
 *
 *   endpoint — an operator-run OpenAI-compatible base URL. Probed actively:
 *              GET {base}/models must list every reserved model id, and with
 *              probe_completion a 1-token completion per model must succeed.
 *   node     — a registered Infernet node (outbound-only, so it cannot be
 *              dialled). Probed from its signed heartbeat: status available,
 *              heartbeat < 90s old, and every reserved model in served_models.
 */

const PROBE_TIMEOUT_MS = 10_000;
const NODE_FRESH_MS = 90_000;

function authHeaders(res) {
    const key = endpointApiKey(res);
    return key ? { authorization: `Bearer ${key}` } : {};
}

async function timedFetch(url, init = {}, timeoutMs = PROBE_TIMEOUT_MS) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: ctl.signal, cache: "no-store" });
    } finally {
        clearTimeout(t);
    }
}

export async function probeEndpoint(res) {
    const t0 = Date.now();
    try {
        const r = await timedFetch(`${res.endpoint_url}/models`, { headers: authHeaders(res) });
        if (!r.ok) return { ok: false, latency_ms: Date.now() - t0, detail: `GET /models -> HTTP ${r.status}` };
        const body = await r.json().catch(() => null);
        const listed = new Set((body?.data ?? []).map((m) => m?.id).filter(Boolean));
        const missing = res.models.filter((m) => !listed.has(m));
        if (missing.length) {
            return { ok: false, latency_ms: Date.now() - t0, detail: `model not listed: ${missing.join(", ")}` };
        }
        if (res.probe_completion) {
            for (const model of res.models) {
                const c = await timedFetch(`${res.endpoint_url}/chat/completions`, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...authHeaders(res) },
                    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, temperature: 0 })
                });
                if (!c.ok) return { ok: false, latency_ms: Date.now() - t0, detail: `completion ${model} -> HTTP ${c.status}` };
                const j = await c.json().catch(() => null);
                if (j?.model && j.model !== model) {
                    return { ok: false, latency_ms: Date.now() - t0, detail: `asked ${model}, served ${j.model}` };
                }
            }
        }
        return { ok: true, latency_ms: Date.now() - t0, detail: res.probe_completion ? "models listed + completion ok" : "models listed" };
    } catch (e) {
        return { ok: false, latency_ms: Date.now() - t0, detail: e?.name === "AbortError" ? `timeout after ${PROBE_TIMEOUT_MS}ms` : (e?.message ?? String(e)) };
    }
}

export async function probeNode(res, now = Date.now()) {
    const t0 = Date.now();
    const { data: p, error } = await getSupabaseServerClient().from("providers")
        .select("id, status, last_seen, specs").eq("id", res.provider_id).maybeSingle();
    const latency_ms = Date.now() - t0;
    if (error) return { ok: false, latency_ms, detail: `lookup failed: ${error.message}` };
    return { ...judgeNode(p, res.models, now), latency_ms };
}

/** Pure verdict for a node target (exported for tests). */
export function judgeNode(p, models, now = Date.now()) {
    if (!p) return { ok: false, detail: "node not found" };
    if (p.status !== "available") return { ok: false, detail: `node status ${p.status}` };
    const age = now - new Date(p.last_seen ?? 0).getTime();
    if (!(age < NODE_FRESH_MS)) return { ok: false, detail: `last heartbeat ${Math.round(age / 1000)}s ago` };
    const served = new Set(Array.isArray(p.specs?.served_models) ? p.specs.served_models : []);
    const missing = models.filter((m) => !served.has(m));
    if (missing.length) return { ok: false, detail: `model not served: ${missing.join(", ")}` };
    return { ok: true, detail: "heartbeat fresh, models served" };
}

export function probe(res, now) {
    return res.target_kind === "endpoint" ? probeEndpoint(res) : probeNode(res, now);
}

/** POST a chat completion to an endpoint target. Returns the raw fetch Response. */
export function forwardToEndpoint(res, body, { timeoutMs = 10 * 60 * 1000 } = {}) {
    return timedFetch(`${res.endpoint_url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(res) },
        body: JSON.stringify(body)
    }, timeoutMs);
}
