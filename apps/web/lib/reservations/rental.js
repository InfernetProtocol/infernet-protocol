/**
 * The rented-GPU providers behind self-serve orders — one registry, so adding
 * a provider is a row here instead of a branch everywhere
 * (docs/prd/16-managed-endpoints.md, "Rented GPU providers").
 *
 * An order is served one of two ways:
 *
 *   - on a NETWORK node: a provider on the Infernet network that already
 *     reports the GPU class and serves the models (orders.js pickNode). Those
 *     classes are the datacenter tiers in pricing.js.
 *   - on a RENTED GPU: we rent one for the window from a cloud and run the
 *     inference service on it ourselves. The buyer gets the same thing either
 *     way — an Infernet endpoint and key — and never sees the cloud.
 *
 * Every rented provider is a module pair: a pure one (tiers, specs, model
 * rules) and a server one in lib/data/ that makes the calls. This file is the
 * pure half's index. It knows nothing about which provider is configured — ask
 * lib/data/rental.js for that, because keys live on the server.
 *
 * Class ids are namespaced per provider (`vast-rtx4090`, `thunder-a100`) with
 * the exception of Salad, which shipped first on bare card names (`rtx4090`)
 * and keeps them so live orders and docs stay valid.
 */

import { SALAD_TIERS, isSaladClass, saladModelError, modelsFitting as saladModelsFitting } from "./salad.js";
import { VAST_TIERS, isVastClass, vastModelError, modelsFitting as vastModelsFitting } from "./vast.js";
import { THUNDER_TIERS, isThunderClass, thunderModelError, modelsFitting as thunderModelsFitting } from "./thunder.js";

/**
 * The providers, in the order a buyer should see them: cheapest-per-class
 * consumer capacity first, datacenter cards last.
 *
 * - `operator_name` is what the order and the reservation show as the operator,
 *   since there is no node operator to name.
 * - `env` is the keys lib/data/rental.js needs before the provider is on sale.
 *   They are listed here so the capacity endpoint and the admin page can say
 *   what is missing without importing server code.
 */
export const RENTAL_PROVIDERS = Object.freeze([
    Object.freeze({
        id: "salad",
        label: "SaladCloud",
        operator_name: "Infernet on SaladCloud",
        runtime: "vllm",
        tiers: SALAD_TIERS,
        env: ["SALAD_API_KEY", "SALAD_ORG", "SALAD_PROJECT"],
        // A Salad group can be created stopped, so it is made when the order is
        // paid and started during warm-up; it bills only while running.
        provision: "payment",
        isClass: isSaladClass,
        modelError: saladModelError,
        // Salad's own helper takes VRAM, not a class id.
        modelsFor: (gpuClass) => saladModelsFitting(SALAD_TIERS[gpuClass]?.vram_gb ?? 0)
    }),
    Object.freeze({
        id: "vast",
        label: "Vast.ai",
        operator_name: "Infernet on Vast.ai",
        runtime: "vllm",
        tiers: VAST_TIERS,
        env: ["VAST_API_KEY"],
        // A rented instance bills from the moment it exists, so it is not
        // rented until warm-up, however far out the booking is.
        provision: "warmup",
        isClass: isVastClass,
        modelError: vastModelError,
        modelsFor: vastModelsFitting
    }),
    Object.freeze({
        id: "thunder",
        label: "Thunder Compute",
        operator_name: "Infernet on Thunder Compute",
        runtime: "ollama",
        tiers: THUNDER_TIERS,
        env: ["THUNDER_API_TOKEN"],
        provision: "warmup",
        isClass: isThunderClass,
        modelError: thunderModelError,
        modelsFor: thunderModelsFitting
    })
]);

export const RENTAL_PROVIDER_IDS = Object.freeze(RENTAL_PROVIDERS.map((p) => p.id));

/** Every rented tier, keyed by class id. Merged into ALL_TIERS by pricing.js. */
export const RENTAL_TIERS = Object.freeze(Object.assign({}, ...RENTAL_PROVIDERS.map((p) => p.tiers)));

/** The provider that serves a class, or null when the class is a network one. */
export function rentalProviderOf(gpuClass) {
    if (typeof gpuClass !== "string") return null;
    const id = gpuClass.trim().toLowerCase();
    return RENTAL_PROVIDERS.find((p) => p.isClass(id)) ?? null;
}

/** True when this class is served by renting rather than by a network node. */
export function isRentalClass(gpuClass) {
    return rentalProviderOf(gpuClass) !== null;
}

export function providerById(id) {
    return RENTAL_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Who the order names as operator: the renting provider, or the node's own name. */
export function operatorNameFor(gpuClass, node = null) {
    const p = rentalProviderOf(gpuClass);
    if (p) return p.operator_name;
    return node ? (node.name || `node ${node.id}`) : null;
}

/**
 * Validate the models for a rented class: exactly one, and it has to fit.
 * Returns an error string, or null for a valid order or a network class.
 */
export function rentalModelError(gpuClass, models) {
    const p = rentalProviderOf(gpuClass);
    return p ? p.modelError(gpuClass, models) : null;
}

/** The model ids on offer for a rented class. */
export function rentalModelsFor(gpuClass) {
    const p = rentalProviderOf(gpuClass);
    return p ? p.modelsFor(gpuClass) : [];
}

/** The hour before start_at that the setup fee pays for: image pull, model load. */
export const WARMUP_MS = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * What a rented order's reservation points at between payment and the moment
 * the rented box answers.
 *
 * It has to be a syntactically valid http(s) URL, because that is what a
 * reservation accepts (lib/reservations/core.js), and it has to be impossible
 * to reach: `.invalid` is reserved by RFC 2606 and resolves nowhere, so a
 * request that goes out before the cron has filled in the real address fails
 * closed instead of reaching a stranger's server.
 */
export const PENDING_ENDPOINT_URL = "https://pending.rental.invalid/v1";

export function isPendingEndpoint(url) {
    return typeof url === "string" && url.startsWith("https://pending.rental.invalid");
}

/**
 * What the cron should do with a paid rented order now:
 *
 *   "rent"   — rent the box: warm-up has started and nothing is rented yet
 *   "start"  — start what already exists (a stopped Salad group)
 *   "serve"  — it is rented: resolve its address, load the model, point the
 *              reservation at it. Repeats every minute until it is serving.
 *   "delete" — the window is over; give the box back
 *   null     — nothing to do yet
 *
 * `order` is { rental_provider, rental_ref, rental_state, start_at, hours }.
 * Order matters: the end of the window wins over everything else, so a booking
 * that somehow slept through its window is torn down rather than started.
 */
export function rentalAction(order, now = Date.now()) {
    const provider = providerById(order?.rental_provider ?? null);
    const start = Date.parse(order?.start_at ?? "");
    const hours = Number(order?.hours);
    // Number(null) is 0 and finite, which would make an hours-less row look
    // like a window that has already ended — and so be torn down on sight.
    if (!provider || !Number.isFinite(start) || !(hours > 0)) return null;

    const state = order.rental_state ?? (order.rental_ref ? "created" : "pending");
    if (state === "deleted") return null;

    const end = start + hours * HOUR_MS;
    if (now >= end) return "delete";
    if (now < start - WARMUP_MS) return null;

    if (state === "pending") return provider.provision === "warmup" ? "rent" : null;
    if (provider.provision === "warmup") return state === "started" ? null : "serve";
    return state === "created" ? "start" : null;
}
