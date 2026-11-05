/**
 * Thunder Compute-backed order classes — the pure part
 * (docs/prd/16-managed-endpoints.md, "Rented GPU providers").
 *
 * Same deal as Salad and Vast: we sell our own inference service, the buyer
 * gets an Infernet reservation and never sees a Thunder credential or a shell.
 * Underneath, one Thunder instance runs the provider's `ollama` template and
 * serves the one model they booked.
 *
 * ## Why Ollama and not vLLM here
 *
 * Thunder's create-instance API takes a template, a GPU type and a disk size —
 * there is no onstart hook or container image to pass (POST /instances/create:
 * gpu_type, num_gpus, cpu_cores, disk_size_gb, template, public_key). So we
 * cannot hand it a vLLM command line the way we can on Salad and Vast. What it
 * does have is a stock `ollama` template with port 8000 already open, and
 * everything after boot can be driven over that one HTTP port: `POST /api/pull`
 * loads the model, and `/v1` is OpenAI-compatible. No SSH, no agent on the box.
 * The cost is that models are Ollama tags (quantized) rather than HF repos.
 *
 * ## Transport and the open-port problem
 *
 * A forwarded port is reachable at `https://<uuid>-<port>.thundercompute.com`
 * (PATCH /instances/{id}/ports), so this hop is TLS, unlike Vast. But Ollama
 * has no authentication of its own: anyone who learns that hostname can spend
 * our GPU hours. The hostname contains the instance uuid, is never shown to the
 * buyer (they talk to Infernet's /v1 with an Infernet key, and Infernet calls
 * upstream server-side), and the instance exists only for the booked window.
 * That is mitigation, not authentication — so Thunder classes are marked
 * `upstream_authenticated: false`, and the window should stay short.
 *
 * ## Prices
 *
 * Thunder publishes its rate card, GPU specs and live availability without a
 * key (GET /v2/pricing, /v2/specs, /v2/status), so the figures below are a
 * snapshot of that feed and the server side re-reads it at provision time and
 * refuses to buy above the snapshot. Reviewed 2026-11-05.
 *
 * Nothing here touches the database or the network.
 */

import { OLLAMA_MODELS, fitting, largestFitting, oneFittingModelError } from "./rental-models.js";
import { priceFromCost } from "./margin.js";

/** When the snapshot below was last read from GET /v2/pricing. */
export const THUNDER_PRICES_REVIEWED = "2026-11-05";

/** The Thunder template whose image serves Ollama, and the port it opens. */
export const THUNDER_TEMPLATE = "ollama";
export const THUNDER_PORT = 8000;

/** Smallest disk Thunder allows, and the per-GB-hour it charges for it. */
export const DISK_GB = 100;
export const DISK_PER_GB_HOUR = 0.0003;

/**
 * [class id, Thunder's gpu_type, spec key, card label, VRAM GB, GPU $/hour,
 *  vCPUs we take (the cheapest option: more bills extra)]
 */
const CLASS_ROWS = [
    ["thunder-a6000", "a6000", "a6000_x1", "RTX A6000", 48, 0.35, 6],
    ["thunder-l40", "l40", "l40_x1", "NVIDIA L40", 48, 0.79, 6],
    ["thunder-a100", "a100xl", "a100xl_x1", "NVIDIA A100", 80, 1.09, 8],
    ["thunder-h100", "h100", "h100_x1", "NVIDIA H100", 80, 3.2, 4]
];

/** Disk is billed on top of the GPU hour, so it belongs in our cost. */
export const DISK_PER_HOUR = Math.round(DISK_GB * DISK_PER_GB_HOUR * 1e6) / 1e6;

export const THUNDER_CLASSES = Object.freeze(Object.fromEntries(CLASS_ROWS.map(([id, gpuType, specKey, card, vram, gpu, vcpus]) =>
    [id, Object.freeze({
        gpu_type: gpuType,
        spec_key: specKey,
        card,
        vram_gb: vram,
        gpu_per_hour: gpu,
        cpu_cores: vcpus,
        // What we pay Thunder per hour for the whole instance.
        cost_per_hour: Math.round((gpu + DISK_PER_HOUR) * 1e6) / 1e6
    })])));

/** Order tiers in the ALL_TIERS shape. */
export const THUNDER_TIERS = Object.freeze(Object.fromEntries(Object.entries(THUNDER_CLASSES).map(([id, c]) => [id, Object.freeze({
    label: `${c.card} ${c.vram_gb}GB`,
    fits: `up to ${largestFitting(OLLAMA_MODELS, c.vram_gb)}B models (quantized), one per order`,
    cost_per_hour: c.cost_per_hour,
    // Admin list price at the default order margin. See vast.js: a bare
    // x2-then-ceil overcharges by a cent on costs like 1.12.
    price_per_hour: priceFromCost(c.cost_per_hour),
    vram_gb: c.vram_gb,
    source: "thunder",
    upstream_authenticated: false
})])));

export function isThunderClass(gpuClass) {
    return typeof gpuClass === "string" && Object.hasOwn(THUNDER_CLASSES, gpuClass.trim().toLowerCase());
}

/** The Ollama tags that fit a Thunder class. */
export function modelsFitting(gpuClass) {
    const c = THUNDER_CLASSES[gpuClass];
    return c ? fitting(OLLAMA_MODELS, c.vram_gb) : [];
}

/** A Thunder order serves exactly one model that fits the card. Error string or null. */
export function thunderModelError(gpuClass, models) {
    const c = THUNDER_CLASSES[gpuClass];
    if (!c) return null;
    return oneFittingModelError({
        gpuClass, label: `${c.card} ${c.vram_gb}GB`, models, catalog: OLLAMA_MODELS, vramGb: c.vram_gb
    });
}

/** THUNDER_API_TOKEN must be set for Thunder classes to be on sale. */
export function thunderConfig(env = process.env) {
    const token = env?.THUNDER_API_TOKEN?.trim();
    if (!token) return null;
    return { token };
}

/** The create body for a class (POST /instances/create). */
export function instanceSpec(gpuClass, publicKey = null) {
    const c = THUNDER_CLASSES[gpuClass];
    if (!c) return null;
    return {
        gpu_type: c.gpu_type,
        num_gpus: 1,
        cpu_cores: c.cpu_cores,
        disk_size_gb: DISK_GB,
        template: THUNDER_TEMPLATE,
        ...(publicKey ? { public_key: publicKey } : {})
    };
}

/**
 * What Thunder's live rate card says this class costs us per hour, in the same
 * shape as `cost_per_hour`. Returns null when the feed does not price it.
 */
export function liveCostOf(pricing, gpuClass) {
    const c = THUNDER_CLASSES[gpuClass];
    const table = pricing?.pricing ?? pricing;
    if (!c || !table || typeof table !== "object") return null;
    const gpu = Number(table[c.spec_key] ?? table[c.gpu_type]);
    if (!Number.isFinite(gpu) || gpu <= 0) return null;
    const perGb = Number(table.disk_gb);
    const disk = Number.isFinite(perGb) && perGb > 0 ? DISK_GB * perGb : DISK_PER_HOUR;
    return Math.round((gpu + disk) * 1e6) / 1e6;
}

/** True when GET /v2/status reports this class's spec as available. */
export function isAvailable(status, gpuClass) {
    const c = THUNDER_CLASSES[gpuClass];
    if (!c) return false;
    const specs = status?.specs;
    if (specs && typeof specs === "object" && Object.hasOwn(specs, c.spec_key)) {
        return String(specs[c.spec_key]).toLowerCase() === "available";
    }
    const byType = status?.gpu_type?.[c.gpu_type];
    if (byType && typeof byType === "object") return String(byType["1"]).toLowerCase() === "available";
    return false;
}

/** The HTTPS address of a forwarded port on an instance. */
export function endpointOf(instance) {
    const uuid = String(instance?.uuid ?? "").trim();
    if (!uuid) return null;
    const ports = Array.isArray(instance?.httpPorts) ? instance.httpPorts.map(Number) : [];
    if (!ports.includes(THUNDER_PORT)) return null;
    const base = `https://${uuid}-${THUNDER_PORT}.thundercompute.com`;
    return { url: `${base}/v1`, base, uuid };
}

/** Thunder reports instance state as a free-text status; map it the way vast.js does. */
export function instancePhase(instance) {
    const status = String(instance?.status ?? "").toLowerCase();
    if (status === "running") return "running";
    if (["stopped", "terminated", "deleted", "failed", "error"].includes(status)) return "dead";
    return "starting";
}
