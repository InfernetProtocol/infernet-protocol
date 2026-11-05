import "server-only";
import { randomBytes } from "node:crypto";
import { rentalProviderOf, providerById, RENTAL_PROVIDERS } from "@/lib/reservations/rental";
import { saladOnSale, createOrderGroup, startGroup, deleteGroup } from "@/lib/data/salad";
import { vastOnSale, createOrderInstance as rentVast, resolveEndpoint as vastEndpoint, destroyInstance as destroyVast, hasOffer } from "@/lib/data/vast";
import { thunderOnSale, createOrderInstance as rentThunder, resolveEndpoint as thunderEndpoint, deleteInstance as deleteThunder, availableClasses, pullModel, isModelReady } from "@/lib/data/thunder";
import { THUNDER_CLASSES } from "@/lib/reservations/thunder";
import { VAST_CLASSES } from "@/lib/reservations/vast";

/**
 * The server half of the rented-GPU registry: which providers can sell right
 * now, and the four verbs the cron drives them with (rent, start, serve,
 * delete). The pure half is lib/reservations/rental.js.
 *
 * Every provider here is reached the same way, so the cron has no idea which
 * cloud an order is on, and adding the next one is a row in the registry plus
 * an adapter pair — not another branch in the cron.
 */

/** Live offer/availability checks are per-request work; hold them briefly. */
const AVAILABILITY_TTL_MS = 60 * 1000;
let availabilityCache = null;

function onSaleFlags() {
    return { salad: saladOnSale(), vast: vastOnSale(), thunder: thunderOnSale() };
}

/**
 * Per class: can it be ordered this minute?
 *
 * "Configured" is not the same as "available", and the capacity endpoint must
 * not promise what we cannot buy:
 *   - Salad sells on demand, so a configured account is enough.
 *   - Vast is a marketplace: there has to be an offer at or under our ceiling.
 *   - Thunder publishes availability and a rate card: the spec has to be free
 *     and its live price still at or under what we quote from.
 *
 * Checks that need a key are skipped when the provider has none — the class is
 * simply not on sale — and a provider whose API is down reads as unavailable
 * rather than taking the whole endpoint down with it.
 */
export async function rentalAvailability() {
    if (availabilityCache && availabilityCache.at + AVAILABILITY_TTL_MS > Date.now()) return availabilityCache.value;
    const onSale = onSaleFlags();
    const value = {};

    for (const gpuClass of Object.keys(providerById("salad").tiers)) {
        value[gpuClass] = { provider: "salad", available: onSale.salad };
    }

    const vastClasses = Object.keys(VAST_CLASSES);
    const vastOffers = onSale.vast
        ? await Promise.all(vastClasses.map((c) => hasOffer(c)))
        : vastClasses.map(() => false);
    vastClasses.forEach((gpuClass, i) => {
        value[gpuClass] = { provider: "vast", available: onSale.vast && vastOffers[i] };
    });

    let thunder = null;
    if (onSale.thunder) thunder = await availableClasses().catch(() => null);
    for (const gpuClass of Object.keys(THUNDER_CLASSES)) {
        value[gpuClass] = {
            provider: "thunder",
            available: Boolean(onSale.thunder && thunder?.[gpuClass]?.available)
        };
    }

    availabilityCache = { at: Date.now(), value };
    return value;
}

/** Forget the cached availability (tests, and after a key changes). */
export function resetRentalAvailability() {
    availabilityCache = null;
}

/** Is this one class orderable right now? */
export async function classAvailable(gpuClass) {
    const p = rentalProviderOf(gpuClass);
    if (!p) return false;
    const all = await rentalAvailability();
    return Boolean(all[String(gpuClass).trim().toLowerCase()]?.available);
}

/** Which providers have their keys here, for the capacity endpoint and /admin. */
export function rentalProviderStatus() {
    const onSale = onSaleFlags();
    return RENTAL_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        runtime: p.runtime,
        configured: Boolean(onSale[p.id]),
        missing_env: onSale[p.id] ? [] : p.env
    }));
}

/**
 * Rent (or, for Salad, create stopped) the box for a paid order.
 *
 * Returns { ref, endpoint } where endpoint is { url, apiKey } once it is known
 * and null when it is not yet: a Salad group publishes its gateway address at
 * creation, while a Vast or Thunder instance has no address until it boots, so
 * `serveRental` fills that in during warm-up.
 */
export async function provisionRental({ orderId, gpuClass, model }) {
    const provider = rentalProviderOf(gpuClass);
    if (!provider) throw Object.assign(new Error(`${gpuClass} is not a rented class`), { status: 400 });

    if (provider.id === "salad") {
        const apiKey = randomBytes(24).toString("base64url");
        const group = await createOrderGroup({ orderId, gpuClass, model, apiKey });
        return { provider: provider.id, ref: group.name, state: "created", endpoint: { url: group.url, apiKey } };
    }
    if (provider.id === "vast") {
        const apiKey = randomBytes(24).toString("base64url");
        const rented = await rentVast({ orderId, gpuClass, model, apiKey });
        return { provider: provider.id, ref: rented.ref, state: "created", endpoint: null, apiKey };
    }
    if (provider.id === "thunder") {
        // Ollama has no key of its own; the endpoint's secrecy is all there is.
        const rented = await rentThunder({ gpuClass, model });
        return { provider: provider.id, ref: rented.ref, state: "created", endpoint: null, apiKey: null };
    }
    throw Object.assign(new Error(`no adapter for ${provider.id}`), { status: 500 });
}

/** Start a box that already exists and is stopped. Only Salad has this step. */
export async function startRental({ provider, ref }) {
    if (provider === "salad") return startGroup(ref);
    return undefined;
}

/**
 * Is the rented box serving yet, and at what address?
 *
 * Returns { ready, url } — `ready: false` means "still coming up, ask again
 * next minute". Throws when the box has reached a state it cannot leave, so
 * the caller can tear it down and mark the order failed rather than wait out
 * the whole window.
 */
export async function serveRental({ provider, ref, model, apiKey = null }) {
    if (provider === "vast") {
        const endpoint = await vastEndpoint(ref);
        if (!endpoint) return { ready: false };
        // vLLM serves the one model it was started with and checks our bearer
        // key itself, so an answering endpoint is a serving endpoint.
        return { ready: true, url: endpoint.url, apiKey };
    }
    if (provider === "thunder") {
        const endpoint = await thunderEndpoint(ref);
        if (!endpoint) return { ready: false };
        if (await isModelReady(endpoint.base, model)) return { ready: true, url: endpoint.url, apiKey: null };
        // Pulling is slow and idempotent: Ollama ignores a pull of what it has.
        await pullModel(endpoint.base, model).catch(() => false);
        return { ready: await isModelReady(endpoint.base, model), url: endpoint.url, apiKey: null };
    }
    return { ready: true };
}

/** Give the box back. Idempotent: one that is already gone counts as deleted. */
export async function deleteRental({ provider, ref }) {
    if (!ref) return;
    if (provider === "salad") return deleteGroup(ref);
    if (provider === "vast") return destroyVast(ref);
    if (provider === "thunder") return deleteThunder(ref);
    return undefined;
}
