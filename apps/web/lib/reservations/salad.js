/**
 * SaladCloud-backed order classes — the pure part (docs/prd/16-managed-endpoints.md,
 * "Consumer GPUs on SaladCloud").
 *
 * We sell our own inference service, not raw Salad compute: the buyer gets an
 * Infernet reservation (an OpenAI-compatible endpoint behind /v1 and an Infernet
 * API key). Underneath, one Salad container group runs vLLM serving the one
 * model they booked. SaladCloud's terms (section 6, item 20) forbid reselling
 * raw compute without a written agreement, and expressly allow selling an
 * inference service that runs on it; this is that, so the buyer never sees
 * Salad credentials, a Salad URL or a shell.
 *
 * Our cost is Salad's per-GPU-hour price at the High priority tier (consumer
 * nodes can still be interrupted; High is the least likely). The order price
 * is that cost marked up by the house margin (margin.js, default 100%).
 *
 * The container group is created stopped when the order is paid, started
 * WARMUP_MS before start_at (the setup fee pays for that hour) and deleted at
 * the end of the window. Nothing here touches the database or the network.
 */

/** Effective 2026-11-01 00:00 UTC (salad.com/pricing), USD per GPU-hour. */
export const SALAD_PRICES_EFFECTIVE = "2026-11-01T00:00:00Z";
export const SALAD_PRIORITY = "high";

// [class id, Salad's card name, VRAM GB, high, medium, low, batch]
const PRICE_ROWS = [
    ["rtx5090", "RTX 5090", 32, 0.600, 0.483, 0.367, 0.250],
    ["rtx4090", "RTX 4090", 24, 0.440, 0.347, 0.253, 0.160],
    ["rtx5080", "RTX 5080", 16, 0.320, 0.263, 0.207, 0.150],
    ["rtx5070ti", "RTX 5070 Ti", 16, 0.270, 0.213, 0.157, 0.100],
    ["rtx4080", "RTX 4080", 16, 0.270, 0.217, 0.163, 0.110],
    ["rtx4070tisuper", "RTX 4070 Ti Super", 16, 0.240, 0.190, 0.140, 0.090],
    ["rtx3090ti", "RTX 3090 Ti", 24, 0.220, 0.180, 0.140, 0.100],
    ["rtx3090", "RTX 3090", 24, 0.200, 0.163, 0.127, 0.090],
    ["rtx5070", "RTX 5070", 12, 0.200, 0.160, 0.120, 0.080],
    ["rtx4070ti", "RTX 4070 Ti", 12, 0.200, 0.160, 0.120, 0.080],
    ["rtx3080ti", "RTX 3080 Ti", 12, 0.195, 0.157, 0.118, 0.080],
    ["rtx4070", "RTX 4070", 12, 0.165, 0.133, 0.102, 0.070],
    ["rtx5060ti", "RTX 5060 Ti", 16, 0.155, 0.127, 0.098, 0.070],
    ["rtx3080", "RTX 3080", 10, 0.155, 0.123, 0.092, 0.060],
    ["rtx4060ti", "RTX 4060 Ti", 16, 0.140, 0.120, 0.100, 0.080]
];

export const SALAD_PRICES = Object.freeze(Object.fromEntries(PRICE_ROWS.map(([id, card, vram, high, medium, low, batch]) =>
    [id, Object.freeze({ card, vram_gb: vram, high, medium, low, batch })])));

/**
 * Models we serve on Salad: open weights, ungated on Hugging Face (no token
 * needed to pull), with the VRAM they need under vLLM at a 8k context.
 */
export const SALAD_MODELS = Object.freeze([
    { id: "Qwen/Qwen2.5-1.5B-Instruct", params_b: 1.5, vram_gb: 8 },
    { id: "Qwen/Qwen2.5-3B-Instruct", params_b: 3, vram_gb: 10 },
    { id: "Qwen/Qwen2.5-7B-Instruct-AWQ", params_b: 7, vram_gb: 10 },
    { id: "Qwen/Qwen2.5-14B-Instruct-AWQ", params_b: 14, vram_gb: 16 },
    { id: "Qwen/Qwen2.5-Coder-14B-Instruct-AWQ", params_b: 14, vram_gb: 16 },
    { id: "Qwen/Qwen2.5-7B-Instruct", params_b: 7, vram_gb: 24 },
    { id: "Qwen/Qwen2.5-32B-Instruct-AWQ", params_b: 32, vram_gb: 24 },
    { id: "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ", params_b: 32, vram_gb: 24 }
]);

export function modelsFitting(vramGb) {
    return SALAD_MODELS.filter((m) => m.vram_gb <= vramGb).map((m) => m.id);
}

/** Order tiers in the GPU_TIERS shape, cost = Salad High. */
export const SALAD_TIERS = Object.freeze(Object.fromEntries(Object.entries(SALAD_PRICES).map(([id, p]) => [id, Object.freeze({
    label: `${p.card} ${p.vram_gb}GB`,
    fits: `up to ${Math.max(...SALAD_MODELS.filter((m) => m.vram_gb <= p.vram_gb).map((m) => m.params_b))}B models, one per order`,
    cost_per_hour: p[SALAD_PRIORITY],
    // Admin list price: twice our cost, the same as the default order margin.
    price_per_hour: Math.ceil(p[SALAD_PRIORITY] * 2 * 100) / 100,
    vram_gb: p.vram_gb,
    source: "salad"
})])));

export function isSaladClass(gpuClass) {
    return typeof gpuClass === "string" && Object.hasOwn(SALAD_TIERS, gpuClass.trim().toLowerCase());
}

/** A Salad order serves exactly one model that fits the card. Returns an error string or null. */
export function saladModelError(gpuClass, models) {
    const tier = SALAD_TIERS[gpuClass];
    if (!tier) return null;
    if (models.length !== 1) return `${gpuClass} orders serve exactly one model`;
    const fit = modelsFitting(tier.vram_gb);
    return fit.includes(models[0]) ? null : `${models[0]} is not offered on ${tier.label}; pick one of ${fit.join(", ")}`;
}

/** SALAD_API_KEY, SALAD_ORG and SALAD_PROJECT must all be set for Salad classes to be on sale. */
export function saladConfig(env = process.env) {
    const apiKey = env?.SALAD_API_KEY?.trim();
    const org = env?.SALAD_ORG?.trim();
    const project = env?.SALAD_PROJECT?.trim();
    if (!apiKey || !org || !project) return null;
    return { apiKey, org, project, image: env?.SALAD_VLLM_IMAGE?.trim() || "vllm/vllm-openai:v0.11.0" };
}

/** Salad names a class like "RTX 4090 (24 GB)"; find the one for our card. */
export function matchGpuClassId(classes, gpuClass) {
    const card = SALAD_PRICES[gpuClass]?.card;
    if (!card) return null;
    const want = card.toLowerCase().replace(/\s+/g, " ");
    const hit = (classes ?? []).find((c) => {
        const name = String(c?.name ?? "").toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
        return name === want || name === `geforce ${want}` || name === `nvidia geforce ${want}`;
    });
    return hit?.id ?? null;
}

/** Container group names: lowercase, digits and dashes, start with a letter, at most 63 characters. */
export function groupName(orderId) {
    return `infernet-${String(orderId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32)}`;
}

/** The container group for an order, created stopped. */
export function containerGroupSpec({ orderId, gpuClassId, model, apiKey, image }) {
    const port = 8000;
    return {
        name: groupName(orderId),
        display_name: `Infernet order ${orderId}`.slice(0, 63),
        autostart_policy: false,
        replicas: 1,
        restart_policy: "always",
        container: {
            image,
            image_caching: true,
            command: [
                "python3", "-m", "vllm.entrypoints.openai.api_server",
                "--model", model,
                "--host", "::",
                "--port", String(port),
                "--api-key", apiKey,
                "--max-model-len", "8192",
                "--gpu-memory-utilization", "0.92"
            ],
            priority: SALAD_PRIORITY,
            resources: { cpu: 4, memory: 30720, gpu_classes: [gpuClassId], shm_size: 2048 },
            environment_variables: {}
        },
        // Gateway auth off: vLLM checks the bearer key itself, and only Infernet holds it.
        networking: { auth: false, port, protocol: "http", load_balancer: "least_number_of_connections", client_request_timeout: 100000, server_response_timeout: 100000 },
        // Salad caps probes (failure_threshold <= 20, period_seconds <= 120), so the model
        // download + load gets 60 s + 20 x 60 s, about 21 minutes, inside the warm-up hour.
        startup_probe: { http: { path: "/health", port, scheme: "http", headers: [] }, initial_delay_seconds: 60, period_seconds: 60, timeout_seconds: 5, success_threshold: 1, failure_threshold: 20 },
        readiness_probe: { http: { path: "/health", port, scheme: "http", headers: [] }, initial_delay_seconds: 0, period_seconds: 10, timeout_seconds: 5, success_threshold: 1, failure_threshold: 3 }
    };
}

export const WARMUP_MS = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * What the cron should do with a paid Salad order now: "start" from WARMUP_MS
 * before start_at until the end, "delete" once the window is over, else null.
 * `state` is what we last did: created | started | deleted.
 */
export function lifecycleAction(order, now = Date.now()) {
    const start = Date.parse(order?.start_at ?? "");
    if (!Number.isFinite(start) || !order?.salad_group) return null;
    const end = start + Number(order.hours) * HOUR_MS;
    const state = order.salad_state ?? "created";
    if (state === "deleted") return null;
    if (now >= end) return "delete";
    if (now >= start - WARMUP_MS && state === "created") return "start";
    return null;
}
