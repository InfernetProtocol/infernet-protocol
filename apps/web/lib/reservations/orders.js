/**
 * Self-serve reservation orders — the pure part (docs/prd/16-managed-endpoints.md,
 * "Self-serve orders").
 *
 * A buyer names a GPU class, the exact models, a start hour and a number of
 * hours. Consumer-card classes (rtx4090 ...) run on SaladCloud instead of a
 * network node: see salad.js; they serve one model each. We sell only what is online: the order is matched to one node that
 * reports that GPU class and already serves every model, and has no other
 * booking in the window. The price is our cost for the class plus the house
 * minimum profit margin (lib/reservations/margin.js, default 100%), prepaid:
 * hours * price_per_hour + the setup fee.
 *
 * Nothing here touches the database or the network.
 */
import { GPU_TIERS, ALL_TIERS, tierOf, setupFeeFor } from "./pricing.js";
import { SALAD_TIERS, isSaladClass, saladModelError, modelsFitting } from "./salad.js";
import { priceFromCost, DEFAULT_MARGIN_PCT } from "./margin.js";

const HOUR_MS = 60 * 60 * 1000;
export const MAX_ORDER_HOURS = 168;
export const MAX_LEAD_DAYS = 30;
/** A node is online when it reported in within this long. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

/** What each class needs from a node's reported GPUs: a model-name match and a count. */
const CLASS_MATCH = Object.freeze({
    l40s: { re: /\bL40S\b/i, count: 1 },
    // A100 40GB exists; the list price is for the 80GB card, so it must report >=48gb.
    a100: { re: /\bA100\b/i, count: 1, vram: ">=48gb" },
    h100: { re: /\bH100\b/i, count: 1 },
    h100x2: { re: /\bH100\b/i, count: 2 }
});

export function nextWholeHour(now = Date.now()) {
    return new Date(Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS);
}

function cleanModels(v) {
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
    return [...new Set(list.map((m) => String(m).trim()).filter(Boolean))];
}

/**
 * Validate an order body. Returns { ok, value } or { ok:false, errors }.
 * start_at defaults to the next whole UTC hour.
 */
export function validateOrderInput(body, now = Date.now()) {
    const b = body ?? {};
    const errors = [];
    const value = {};

    const gpu = typeof b.gpu_class === "string" ? b.gpu_class.trim().toLowerCase() : "";
    if (!tierOf(gpu)) errors.push(`gpu_class must be one of ${Object.keys(ALL_TIERS).join(", ")}`);
    value.gpu_class = gpu;

    value.models = cleanModels(b.models).slice(0, 8);
    if (value.models.length === 0) errors.push("models[] is required (exact model ids, see GET /api/v1/orders/capacity)");
    else if (isSaladClass(gpu)) {
        const e = saladModelError(gpu, value.models);
        if (e) errors.push(e);
    }

    const hours = typeof b.hours === "string" && b.hours.trim() !== "" ? Number(b.hours) : (b.hours ?? 1);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_ORDER_HOURS) {
        errors.push(`hours must be an integer in [1, ${MAX_ORDER_HOURS}]`);
    }
    value.hours = hours;

    const earliest = nextWholeHour(now).getTime();
    const start = b.start_at ? new Date(b.start_at) : new Date(earliest);
    if (Number.isNaN(start.getTime())) {
        errors.push("start_at must be an ISO timestamp");
    } else if (start.getTime() % HOUR_MS !== 0) {
        errors.push("start_at must be a whole UTC hour (e.g. 2026-10-28T15:00:00Z)");
    } else if (start.getTime() < earliest) {
        errors.push(`start_at must be the next whole hour or later (earliest ${new Date(earliest).toISOString()})`);
    } else if (start.getTime() > now + MAX_LEAD_DAYS * 24 * HOUR_MS) {
        errors.push(`start_at must be within ${MAX_LEAD_DAYS} days`);
    }
    value.start_at = Number.isNaN(start.getTime()) ? null : start.toISOString();

    const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
    value.name = name || null;
    const email = typeof b.email === "string" ? b.email.trim() : "";
    if (email && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) errors.push("email is not an email address");
    value.email = email || null;
    value.provider_id = typeof b.provider_id === "string" && b.provider_id.trim() ? b.provider_id.trim() : null;

    return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** The prepaid quote for a class and a number of hours, at a margin over our cost. */
export function quoteFor(gpuClass, hours, marginPct = DEFAULT_MARGIN_PCT) {
    const tier = tierOf(gpuClass);
    if (!tier) return null;
    const price = priceFromCost(tier.cost_per_hour, marginPct);
    const setup = setupFeeFor(price);
    const total = Math.round((price * hours + setup) * 100) / 100;
    return { gpu_class: gpuClass, label: tier.label, fits: tier.fits, hours, price_per_hour: price, setup_fee: setup, total_usd: total, currency: "USD" };
}

function gpusOf(provider) {
    const gpus = (Array.isArray(provider?.specs?.gpus) ? provider.specs.gpus : [])
        .map((g) => ({ model: String(g?.model ?? g?.name ?? ""), vram_tier: g?.vram_tier ?? "unknown" }))
        .filter((g) => g.model);
    if (gpus.length === 0 && provider?.gpu_model) gpus.push({ model: String(provider.gpu_model), vram_tier: "unknown" });
    return gpus;
}

/** Which classes a node can be sold as, from the GPUs it reports. */
export function classesOf(provider) {
    const gpus = gpusOf(provider);
    return Object.entries(CLASS_MATCH)
        .filter(([, m]) => gpus.filter((g) => m.re.test(g.model) && (!m.vram || g.vram_tier === m.vram)).length >= m.count)
        .map(([k]) => k);
}

export function servedModels(provider) {
    const s = provider?.specs?.served_models;
    return Array.isArray(s) ? s.filter((m) => typeof m === "string" && m) : [];
}

export function isOnline(provider, now = Date.now()) {
    const seen = Date.parse(provider?.last_seen ?? "");
    return provider?.status === "available" && Number.isFinite(seen) && now - seen <= ONLINE_WINDOW_MS;
}

function overlaps(aStart, aHours, bStart, bHours) {
    const a0 = Date.parse(aStart);
    const b0 = Date.parse(bStart);
    return a0 < b0 + bHours * HOUR_MS && b0 < a0 + aHours * HOUR_MS;
}

/**
 * Pick the node to sell. `bookings` are { provider_id, start_at, hours } for
 * every live reservation and unexpired order. Highest reputation wins, then
 * the most recently seen, so the choice is stable for a retried request.
 */
export function pickNode(providers, order, bookings = [], now = Date.now()) {
    const busy = new Set(
        bookings.filter((b) => overlaps(b.start_at, b.hours, order.start_at, order.hours)).map((b) => String(b.provider_id))
    );
    const fits = (providers ?? []).filter((p) =>
        isOnline(p, now)
        && (p.trust_tier ?? "public") !== "private"
        && !busy.has(String(p.id))
        && (!order.provider_id || String(p.id) === order.provider_id)
        && classesOf(p).includes(order.gpu_class)
        && order.models.every((m) => servedModels(p).includes(m))
    );
    fits.sort((a, b) => (Number(b.reputation ?? 0) - Number(a.reputation ?? 0))
        || (Date.parse(b.last_seen) - Date.parse(a.last_seen))
        || String(a.id).localeCompare(String(b.id)));
    return fits[0] ?? null;
}

/**
 * What is on sale right now, per class: how many nodes and which models.
 * Salad classes are on demand (no node count) and on sale only when `salad`
 * is true, i.e. the Salad account is configured.
 */
export function capacity(providers, bookings = [], now = Date.now(), marginPct = DEFAULT_MARGIN_PCT, { salad = false } = {}) {
    const start = nextWholeHour(now).toISOString();
    const onDemand = Object.entries(SALAD_TIERS).map(([gpu_class, t]) => ({
        ...quoteFor(gpu_class, 1, marginPct), hours: undefined, total_usd: undefined,
        source: "salad", available: salad, nodes_available: null, models: modelsFitting(t.vram_gb), models_per_order: 1
    }));
    return [...Object.keys(GPU_TIERS).map((gpu_class) => {
        const nodes = (providers ?? []).filter((p) =>
            isOnline(p, now) && (p.trust_tier ?? "public") !== "private" && classesOf(p).includes(gpu_class)
            && !bookings.some((b) => String(b.provider_id) === String(p.id) && overlaps(b.start_at, b.hours, start, 1)));
        const models = [...new Set(nodes.flatMap(servedModels))].sort();
        return { ...quoteFor(gpu_class, 1, marginPct), hours: undefined, total_usd: undefined, source: "network", available: nodes.length > 0, nodes_available: nodes.length, models };
    }), ...onDemand];
}

/**
 * The reservation an order becomes once paid. Limits are the self-serve
 * defaults. A Salad order passes `endpoint` (its container group's base URL
 * and the vLLM key only Infernet holds) instead of pinning a node.
 */
export function reservationFromOrder(order, endpoint = null) {
    return {
        name: order.name || `order ${order.id}`,
        buyer: order.email ?? null,
        operator_name: order.operator_name,
        target_kind: endpoint ? "endpoint" : "node",
        provider_id: endpoint ? null : order.provider_id,
        endpoint_url: endpoint ? endpoint.url : null,
        endpoint_api_key: endpoint ? endpoint.apiKey : null,
        models: order.models,
        start_at: order.start_at,
        hours: order.hours,
        included_tokens: 0,
        per_key_rps: 2,
        per_key_concurrency: 2,
        shared_rps: 10,
        shared_concurrency: 8,
        required_minutes_per_hour: 60,
        probe_completion: false,
        currency: "USD",
        price_per_hour: Number(order.price_per_hour),
        gpu_class: order.gpu_class,
        setup_fee: Number(order.setup_fee),
        notes: `self-serve order ${order.id}, prepaid ${order.total_usd} USD via ${order.rail}`
    };
}

export const ORDER_TERMS = "Prepaid at the quoted price. Every minute is probed; hours the report marks non-compliant are credited or refunded.";
