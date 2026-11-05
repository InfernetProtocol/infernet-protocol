/**
 * Vast.ai-backed order classes — the pure part (docs/prd/16-managed-endpoints.md,
 * "Rented GPU providers").
 *
 * Same shape as the SaladCloud classes in salad.js: we sell our own inference
 * service, not raw compute. The buyer gets an Infernet reservation — an
 * OpenAI-compatible endpoint behind /v1 and an Infernet API key — and never
 * sees a Vast credential, a Vast URL or a shell. Underneath, one Vast instance
 * runs vLLM serving the one model they booked.
 *
 * ## Why a ceiling instead of a rate card
 *
 * Vast is a marketplace, not a fixed-price cloud: hosts set their own rates, so
 * there is no published price per card to snapshot (vast.ai/pricing shows live
 * offers only). So each class carries a COST CEILING — the most we will pay per
 * GPU-hour for it — and the offer search at provision time demands
 * `dph_total <= ceiling`. The buyer's price is the ceiling marked up by the
 * house margin, which makes the quote deterministic and means a cheaper offer
 * widens our margin rather than changing their bill. If no offer clears the
 * ceiling the order is refused before any money moves.
 *
 * Ceilings are OUR bid limits, set 2026-11-05 to sit above typical market for
 * each card so an offer normally exists. They are not Vast's prices and should
 * not be presented as such.
 *
 * ## Transport
 *
 * A Vast instance gets a share of a shared public IP: each internal port maps
 * to a random external port (docs.vast.ai "Networking & Ports"). So the
 * endpoint is `http://<public_ipaddr>:<external port>/v1` — plain HTTP to an IP,
 * with no certificate to serve TLS against. Only Infernet calls it, from the
 * server side, and vLLM checks a bearer key only Infernet holds; but the hop
 * itself is unencrypted, which is why Vast classes are marked
 * `encrypted_transport: false` and must not be sold for private workloads.
 *
 * Nothing here touches the database or the network.
 */

import { VLLM_MODELS, fitting, largestFitting, oneFittingModelError } from "./rental-models.js";
import { priceFromCost } from "./margin.js";

/** When the ceilings below were last reviewed against live Vast offers. */
export const VAST_CEILINGS_REVIEWED = "2026-11-05";

/** The vLLM port inside the container. Vast maps it to a random external port. */
export const VAST_PORT = 8000;

/**
 * Only verified hosts, and only ones with a long track record: a rented box
 * that vanishes mid-booking costs us the whole order in refunds.
 */
export const MIN_RELIABILITY = 0.98;
/** Enough room for the image plus the largest model we serve. */
export const DISK_GB = 120;

// [class id, Vast's gpu_name, card label, VRAM GB, our ceiling $/GPU-hour]
const CLASS_ROWS = [
    ["vast-rtx3090", "RTX_3090", "RTX 3090", 24, 0.25],
    ["vast-rtx4090", "RTX_4090", "RTX 4090", 24, 0.45],
    ["vast-rtx5090", "RTX_5090", "RTX 5090", 32, 0.75],
    ["vast-a6000", "RTX_A6000", "RTX A6000", 48, 0.55],
    ["vast-l40s", "L40S", "L40S", 48, 1.0],
    ["vast-a100", "A100_SXM4", "A100 SXM4", 80, 1.4],
    ["vast-h100", "H100_SXM", "H100 SXM", 80, 2.4]
];

export const VAST_CLASSES = Object.freeze(Object.fromEntries(CLASS_ROWS.map(([id, gpuName, card, vram, ceiling]) =>
    [id, Object.freeze({ gpu_name: gpuName, card, vram_gb: vram, ceiling_per_hour: ceiling })])));

/** Order tiers in the ALL_TIERS shape. Cost is our ceiling, so the quote is deterministic. */
export const VAST_TIERS = Object.freeze(Object.fromEntries(Object.entries(VAST_CLASSES).map(([id, c]) => [id, Object.freeze({
    label: `${c.card} ${c.vram_gb}GB`,
    fits: `up to ${largestFitting(VLLM_MODELS, c.vram_gb)}B models, one per order`,
    cost_per_hour: c.ceiling_per_hour,
    // Admin list price at the default order margin. priceFromCost is used
    // rather than a bare x2 because 1.12 * 2 * 100 is 224.00000000000003 in
    // floating point, and ceiling that to the cent overcharges by one.
    price_per_hour: priceFromCost(c.ceiling_per_hour),
    vram_gb: c.vram_gb,
    source: "vast",
    encrypted_transport: false
})])));

export function isVastClass(gpuClass) {
    return typeof gpuClass === "string" && Object.hasOwn(VAST_CLASSES, gpuClass.trim().toLowerCase());
}

/** The vLLM models that fit a Vast class. */
export function modelsFitting(gpuClass) {
    const c = VAST_CLASSES[gpuClass];
    return c ? fitting(VLLM_MODELS, c.vram_gb) : [];
}

/** A Vast order serves exactly one model that fits the card. Error string or null. */
export function vastModelError(gpuClass, models) {
    const c = VAST_CLASSES[gpuClass];
    if (!c) return null;
    return oneFittingModelError({
        gpuClass, label: `${c.card} ${c.vram_gb}GB`, models, catalog: VLLM_MODELS, vramGb: c.vram_gb
    });
}

/** VAST_API_KEY must be set for Vast classes to be on sale. */
export function vastConfig(env = process.env) {
    const apiKey = env?.VAST_API_KEY?.trim();
    if (!apiKey) return null;
    return { apiKey, image: env?.VAST_VLLM_IMAGE?.trim() || "vllm/vllm-openai:v0.11.0" };
}

/**
 * The offer search for a class: the cheapest rentable, verified, reliable
 * on-demand offer with one whole GPU of that model at or under our ceiling.
 * POST /api/v0/bundles.
 */
export function offerQuery(gpuClass) {
    const c = VAST_CLASSES[gpuClass];
    if (!c) return null;
    return {
        q: {
            gpu_name: { eq: c.gpu_name },
            num_gpus: { eq: 1 },
            gpu_ram: { gte: c.vram_gb * 1024 - 2048 },
            rentable: { eq: true },
            verified: { eq: true },
            rented: { eq: false },
            reliability: { gte: MIN_RELIABILITY },
            disk_space: { gte: DISK_GB },
            // Interruptible offers are bid-priced and can be outbid mid-booking.
            dph_total: { lte: c.ceiling_per_hour },
            order: [["dph_total", "asc"]],
            type: "on-demand",
            limit: 20
        }
    };
}

/** The cheapest offer in a bundles response that we are willing to take, or null. */
export function pickOffer(offers, gpuClass) {
    const c = VAST_CLASSES[gpuClass];
    if (!c) return null;
    const usable = (Array.isArray(offers) ? offers : [])
        .filter((o) => Number.isFinite(Number(o?.id))
            && Number.isFinite(Number(o?.dph_total))
            && Number(o.dph_total) > 0
            && Number(o.dph_total) <= c.ceiling_per_hour
            && Number(o?.reliability ?? o?.reliability2 ?? 0) >= MIN_RELIABILITY
            && Number(o?.num_gpus ?? 1) >= 1)
        .sort((a, b) => Number(a.dph_total) - Number(b.dph_total) || Number(a.id) - Number(b.id));
    return usable[0] ?? null;
}

/**
 * The create-instance body for an offer (PUT /api/v0/asks/{id}).
 *
 * `env` carries docker flags, so the port publish lives there; `-e` entries
 * become container environment. The entrypoint is replaced via `args` so the
 * image serves exactly the one booked model with our key.
 */
export function instanceSpec({ orderId, gpuClass, model, apiKey, image }) {
    const c = VAST_CLASSES[gpuClass];
    if (!c) return null;
    return {
        image,
        disk: DISK_GB,
        runtype: "args",
        // Published port + a label we can find the instance by if a create is ever orphaned.
        env: `-p ${VAST_PORT}:${VAST_PORT} -e INFERNET_ORDER=${instanceLabel(orderId)}`,
        label: instanceLabel(orderId),
        onstart: "",
        args: [
            "python3", "-m", "vllm.entrypoints.openai.api_server",
            "--model", model,
            "--host", "0.0.0.0",
            "--port", String(VAST_PORT),
            "--api-key", apiKey,
            "--max-model-len", "8192",
            "--gpu-memory-utilization", "0.92"
        ]
    };
}

/** Instance labels: how we recognise our own rows in a Vast account. */
export function instanceLabel(orderId) {
    return `infernet-${String(orderId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32)}`;
}

/**
 * The external address of an instance's vLLM port, from GET /api/v0/instances/{id}.
 *
 * Vast reports mapped ports in docker-inspect shape
 * (`{"8000/tcp":[{"HostIp":"0.0.0.0","HostPort":"33526"}]}`); older rows and
 * the simplified docs schema use a plain array of integers, in which case the
 * external port is not knowable and we wait for the map. Returns null until
 * both the IP and the mapping are published.
 */
export function endpointOf(instance) {
    const ip = String(instance?.public_ipaddr ?? "").trim();
    if (!ip) return null;
    const ports = instance?.ports;
    let external = null;
    if (ports && !Array.isArray(ports) && typeof ports === "object") {
        const entry = ports[`${VAST_PORT}/tcp`] ?? ports[String(VAST_PORT)];
        const first = Array.isArray(entry) ? entry[0] : entry;
        const p = Number(first?.HostPort ?? first?.host_port ?? first);
        if (Number.isFinite(p) && p > 0) external = p;
    }
    if (!external) return null;
    return { url: `http://${ip}:${external}/v1`, host: ip, port: external };
}

/**
 * Is this instance still on its way up, up, or never going to make it?
 *
 * The documented poll trap: once `actual_status` is exited, unknown or offline
 * it will never reach running, so the caller must destroy and retry rather than
 * keep waiting.
 */
export function instancePhase(instance) {
    const status = String(instance?.actual_status ?? "").toLowerCase();
    if (status === "running") return "running";
    if (["exited", "unknown", "offline"].includes(status)) return "dead";
    return "starting";
}
