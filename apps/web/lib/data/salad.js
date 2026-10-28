import "server-only";
import { saladConfig, containerGroupSpec, matchGpuClassId, modelsFitting } from "@/lib/reservations/salad";

/**
 * SaladCloud public API (api.salad.com/api/public, header Salad-Api-Key):
 * just the four calls a Salad-backed order needs. The pure parts live in
 * lib/reservations/salad.js.
 */

const BASE = "https://api.salad.com/api/public";

export function saladOnSale() {
    return saladConfig() !== null;
}

async function call(cfg, method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { "Salad-Api-Key": cfg.apiKey, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store"
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
        const detail = data?.detail ?? data?.title ?? text.slice(0, 200);
        throw Object.assign(new Error(`SaladCloud ${method} ${path.replace(/^\/organizations\/[^/]+/, "")} -> HTTP ${res.status}: ${detail}`), { status: 502, saladStatus: res.status });
    }
    return data;
}

function groupPath(cfg, name = "") {
    return `/organizations/${encodeURIComponent(cfg.org)}/projects/${encodeURIComponent(cfg.project)}/containers${name ? `/${encodeURIComponent(name)}` : ""}`;
}

function requireConfig() {
    const cfg = saladConfig();
    if (!cfg) throw Object.assign(new Error("SaladCloud is not configured here (SALAD_API_KEY, SALAD_ORG, SALAD_PROJECT)"), { status: 503 });
    return cfg;
}

/**
 * Create an order's container group, stopped. Returns { name, url } where url
 * is the OpenAI base URL behind Salad's gateway.
 */
export async function createOrderGroup({ orderId, gpuClass, model, apiKey }) {
    const cfg = requireConfig();
    const classes = await call(cfg, "GET", `/organizations/${encodeURIComponent(cfg.org)}/gpu-classes`);
    const gpuClassId = matchGpuClassId(classes?.items ?? classes, gpuClass);
    if (!gpuClassId) throw Object.assign(new Error(`SaladCloud has no GPU class for ${gpuClass}`), { status: 502 });
    if (!modelsFitting(Infinity).includes(model)) throw Object.assign(new Error(`${model} is not a Salad model`), { status: 400 });
    const group = await call(cfg, "POST", groupPath(cfg), containerGroupSpec({ orderId, gpuClassId, model, apiKey, image: cfg.image }));
    const dns = group?.networking?.dns;
    if (!dns) throw Object.assign(new Error("SaladCloud created the group without a gateway domain"), { status: 502 });
    return { name: group.name, url: `https://${dns}/v1` };
}

export async function startGroup(name) {
    const cfg = requireConfig();
    await call(cfg, "POST", `${groupPath(cfg, name)}/start`);
}

/** Delete is idempotent: a group that is already gone counts as deleted. */
export async function deleteGroup(name) {
    const cfg = requireConfig();
    try {
        await call(cfg, "DELETE", groupPath(cfg, name));
    } catch (e) {
        if (e?.saladStatus !== 404) throw e;
    }
}
