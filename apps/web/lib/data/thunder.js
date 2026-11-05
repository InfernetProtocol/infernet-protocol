import "server-only";
import {
    thunderConfig, instanceSpec, liveCostOf, isAvailable, endpointOf, instancePhase,
    modelsFitting, THUNDER_CLASSES, THUNDER_PORT
} from "@/lib/reservations/thunder";

/**
 * Thunder Compute API (api.thundercompute.com:8443, Authorization: Bearer) —
 * the calls a Thunder-backed order needs. The pure parts live in
 * lib/reservations/thunder.js.
 *
 * Three of the reads need no key at all (/v2/pricing, /v2/specs, /v2/status),
 * which is why availability and a live cost check work before an account
 * exists. Everything that spends money needs THUNDER_API_TOKEN.
 */

const BASE = "https://api.thundercompute.com:8443";
/** Public catalog reads are cached briefly: the capacity endpoint hits them per request. */
const CATALOG_TTL_MS = 60 * 1000;

const catalogCache = new Map();

export function thunderOnSale() {
    return thunderConfig() !== null;
}

function requireConfig() {
    const cfg = thunderConfig();
    if (!cfg) throw Object.assign(new Error("Thunder Compute is not configured here (THUNDER_API_TOKEN)"), { status: 503 });
    return cfg;
}

async function call(method, path, { body, token } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            accept: "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { "content-type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store"
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
        const detail = data?.message ?? data?.error ?? text.slice(0, 200);
        throw Object.assign(new Error(`Thunder ${method} ${path} -> HTTP ${res.status}: ${detail}`), { status: 502, thunderStatus: res.status });
    }
    return data;
}

/** GET a public catalog endpoint, cached for a minute. */
async function catalog(path) {
    const hit = catalogCache.get(path);
    if (hit && hit.at + CATALOG_TTL_MS > Date.now()) return hit.data;
    const data = await call("GET", path);
    catalogCache.set(path, { at: Date.now(), data });
    return data;
}

export function pricing() {
    return catalog("/v2/pricing");
}

export function status() {
    return catalog("/v2/status");
}

/**
 * Which Thunder classes can be sold right now: Thunder reports the spec as
 * available AND its live price is still at or under the snapshot we quote from.
 * A price rise takes a class off sale rather than eating the margin silently.
 */
export async function availableClasses() {
    const [live, avail] = await Promise.all([pricing().catch(() => null), status().catch(() => null)]);
    const out = {};
    for (const [id, c] of Object.entries(THUNDER_CLASSES)) {
        const cost = live ? liveCostOf(live, id) : null;
        out[id] = {
            available: Boolean(avail && isAvailable(avail, id)) && cost !== null && cost <= c.cost_per_hour + 1e-9,
            live_cost_per_hour: cost,
            quoted_cost_per_hour: c.cost_per_hour
        };
    }
    return out;
}

/** Refuse to rent above what we quoted from. */
async function assertPriceHeld(gpuClass) {
    const c = THUNDER_CLASSES[gpuClass];
    const cost = liveCostOf(await pricing(), gpuClass);
    if (cost === null) throw Object.assign(new Error(`Thunder does not price ${gpuClass} right now`), { status: 502 });
    if (cost > c.cost_per_hour + 1e-9) {
        throw Object.assign(
            new Error(`Thunder now charges $${cost}/h for ${gpuClass}, over the $${c.cost_per_hour}/h this order was quoted from`),
            { status: 409 }
        );
    }
    return cost;
}

export async function listInstances() {
    const cfg = requireConfig();
    const data = await call("GET", "/v1/instances/list", { token: cfg.token });
    // The list is a map of id -> instance; the id only exists as the key.
    if (!data || typeof data !== "object") return [];
    return Object.entries(data).map(([id, v]) => ({ id, ...(v && typeof v === "object" ? v : {}) }));
}

export async function showInstance(id) {
    return (await listInstances()).find((i) => String(i.id) === String(id)) ?? null;
}

export async function deleteInstance(id) {
    const cfg = requireConfig();
    try {
        await call("POST", `/v1/instances/${encodeURIComponent(id)}/delete`, { token: cfg.token, body: {} });
    } catch (e) {
        if (e?.thunderStatus !== 404) throw e;
    }
}

/** Forward the Ollama port so the instance is reachable over HTTPS. */
export async function forwardPort(id, port = THUNDER_PORT) {
    const cfg = requireConfig();
    return call("PATCH", `/v1/instances/${encodeURIComponent(id)}/ports`, {
        token: cfg.token,
        body: { add_ports: [port], remove_ports: [] }
    });
}

/**
 * Rent an instance for an order on the `ollama` template.
 *
 * Returns { ref, model } — the Thunder instance id to delete at the end of the
 * window. The endpoint and the model pull come later (`resolveEndpoint`,
 * `pullModel`), because neither can happen until the box is running.
 */
export async function createOrderInstance({ gpuClass, model }) {
    const cfg = requireConfig();
    if (!THUNDER_CLASSES[gpuClass]) throw Object.assign(new Error(`${gpuClass} is not a Thunder class`), { status: 400 });
    if (!modelsFitting(gpuClass).includes(model)) {
        throw Object.assign(new Error(`${model} is not offered on ${gpuClass}`), { status: 400 });
    }
    const cost = await assertPriceHeld(gpuClass);
    const created = await call("POST", "/v1/instances/create", { token: cfg.token, body: instanceSpec(gpuClass) });
    const ref = created?.identifier ?? created?.uuid ?? null;
    if (ref === null || ref === undefined) {
        throw Object.assign(new Error("Thunder created an instance without returning an identifier"), { status: 502 });
    }
    return { ref: String(ref), uuid: created?.uuid ?? null, cost_per_hour: cost, model };
}

/**
 * The instance's endpoint once it is running and the port is forwarded. Returns
 * { url } when ready, null while it comes up, throws when it never will.
 *
 * The port is forwarded here rather than at create time because Thunder only
 * takes a port patch on a running instance.
 */
export async function resolveEndpoint(ref) {
    const instance = await showInstance(ref);
    if (!instance) return null;
    const phase = instancePhase(instance);
    if (phase === "dead") {
        throw Object.assign(
            new Error(`Thunder instance ${ref} is ${instance.status ?? "gone"} and will not start`),
            { status: 502, thunderDead: true }
        );
    }
    if (phase !== "running") return null;
    let endpoint = endpointOf(instance);
    if (!endpoint) {
        await forwardPort(ref);
        endpoint = endpointOf({ ...instance, httpPorts: [...(instance.httpPorts ?? []), THUNDER_PORT] });
    }
    return endpoint ? { url: endpoint.url, base: endpoint.base } : null;
}

/**
 * Pull the booked model on the instance, over the forwarded port. Ollama
 * streams newline-delimited JSON progress and this can take many minutes on a
 * large model, so it is called during the warm-up hour and the body is drained
 * rather than parsed.
 */
export async function pullModel(base, model) {
    const res = await fetch(`${base}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model, stream: false }),
        cache: "no-store"
    });
    const text = await res.text();
    if (!res.ok) {
        throw Object.assign(new Error(`Thunder ollama pull ${model} -> HTTP ${res.status}: ${text.slice(0, 200)}`), { status: 502 });
    }
    // stream:false answers one object; a trailing {"status":"success"} is the done marker.
    return text.includes("success") || text.trim() === "";
}

/** Has the model finished loading and is the endpoint answering? */
export async function isModelReady(base, model) {
    try {
        const res = await fetch(`${base}/api/tags`, { headers: { accept: "application/json" }, cache: "no-store" });
        if (!res.ok) return false;
        const data = await res.json();
        const names = (Array.isArray(data?.models) ? data.models : []).map((m) => String(m?.name ?? m?.model ?? ""));
        return names.some((n) => n === model || n === `${model}:latest` || n.startsWith(`${model}:`));
    } catch {
        return false;
    }
}
