import "server-only";
import {
    vastConfig, offerQuery, pickOffer, instanceSpec, instanceLabel, endpointOf, instancePhase,
    VAST_CLASSES, VAST_PORT, modelsFitting
} from "@/lib/reservations/vast";

/**
 * Vast.ai REST API (console.vast.ai/api/v0, Authorization: Bearer) — just the
 * calls a Vast-backed order needs. The pure parts live in
 * lib/reservations/vast.js.
 *
 * Documented quirks this file exists to absorb:
 *   - create is PUT /api/v0/asks/{id} and answers `new_contract`, not `id`
 *   - gpu_ram is MB here (GB in the CLI)
 *   - if `actual_status` reaches exited | unknown | offline the instance will
 *     never come up: destroy and retry rather than wait
 */

const BASE = "https://console.vast.ai";

export function vastOnSale() {
    return vastConfig() !== null;
}

function requireConfig() {
    const cfg = vastConfig();
    if (!cfg) throw Object.assign(new Error("Vast.ai is not configured here (VAST_API_KEY)"), { status: 503 });
    return cfg;
}

async function call(cfg, method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            authorization: `Bearer ${cfg.apiKey}`,
            accept: "application/json",
            ...(body ? { "content-type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store"
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok || data?.success === false) {
        const detail = data?.msg ?? data?.error ?? data?.detail ?? text.slice(0, 200);
        throw Object.assign(new Error(`Vast.ai ${method} ${path} -> HTTP ${res.status}: ${detail}`), { status: 502, vastStatus: res.status });
    }
    return data;
}

/** Offers for a class that clear our ceiling, cheapest first. */
export async function searchOffers(gpuClass) {
    const cfg = requireConfig();
    const query = offerQuery(gpuClass);
    if (!query) throw Object.assign(new Error(`${gpuClass} is not a Vast class`), { status: 400 });
    const data = await call(cfg, "POST", "/api/v0/bundles", query);
    return Array.isArray(data?.offers) ? data.offers : [];
}

/** Is there anything rentable at or under our ceiling for this class right now? */
export async function hasOffer(gpuClass) {
    try {
        return pickOffer(await searchOffers(gpuClass), gpuClass) !== null;
    } catch {
        return false;
    }
}

export async function showInstance(id) {
    const cfg = requireConfig();
    const data = await call(cfg, "GET", `/api/v0/instances/${encodeURIComponent(id)}`);
    return data?.instances ?? data?.instance ?? null;
}

/** Destroy is idempotent: an instance that is already gone counts as destroyed. */
export async function destroyInstance(id) {
    const cfg = requireConfig();
    try {
        await call(cfg, "DELETE", `/api/v0/instances/${encodeURIComponent(id)}`);
    } catch (e) {
        if (e?.vastStatus !== 404) throw e;
    }
}

/**
 * Rent the cheapest offer for an order and start vLLM on it.
 *
 * Returns { ref, url, apiKey } where `ref` is the Vast instance id to destroy
 * at the end of the window. The endpoint is not reachable yet: the image has to
 * pull and the model has to load, which is what the warm-up hour is for, and
 * the external port only appears once Vast publishes the mapping — so the URL
 * is resolved later by `resolveEndpoint`.
 */
export async function createOrderInstance({ orderId, gpuClass, model, apiKey }) {
    const cfg = requireConfig();
    if (!VAST_CLASSES[gpuClass]) throw Object.assign(new Error(`${gpuClass} is not a Vast class`), { status: 400 });
    if (!modelsFitting(gpuClass).includes(model)) {
        throw Object.assign(new Error(`${model} is not offered on ${gpuClass}`), { status: 400 });
    }
    const offer = pickOffer(await searchOffers(gpuClass), gpuClass);
    if (!offer) {
        throw Object.assign(
            new Error(`no Vast.ai offer for ${gpuClass} at or under $${VAST_CLASSES[gpuClass].ceiling_per_hour}/h right now`),
            { status: 409 }
        );
    }
    const spec = instanceSpec({ orderId, gpuClass, model, apiKey, image: cfg.image });
    const created = await call(cfg, "PUT", `/api/v0/asks/${encodeURIComponent(offer.id)}`, spec);
    const ref = created?.new_contract ?? created?.instance_id ?? null;
    if (!ref) throw Object.assign(new Error("Vast.ai accepted the offer without returning an instance id"), { status: 502 });
    return {
        ref: String(ref),
        label: instanceLabel(orderId),
        offer_id: offer.id,
        cost_per_hour: Number(offer.dph_total),
        apiKey
    };
}

/**
 * The instance's endpoint once Vast has published its IP and port mapping.
 * Returns { url } when ready, null while it is still coming up, and throws when
 * the instance has reached a state it can never leave.
 */
export async function resolveEndpoint(ref) {
    const instance = await showInstance(ref);
    if (!instance) return null;
    const phase = instancePhase(instance);
    if (phase === "dead") {
        throw Object.assign(
            new Error(`Vast.ai instance ${ref} is ${instance.actual_status ?? "gone"} and will not start`),
            { status: 502, vastDead: true }
        );
    }
    if (phase !== "running") return null;
    const endpoint = endpointOf(instance);
    if (!endpoint) return null;
    return { url: endpoint.url, host: endpoint.host, port: endpoint.port, internal_port: VAST_PORT };
}
