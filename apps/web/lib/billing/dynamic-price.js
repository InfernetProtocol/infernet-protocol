/**
 * Dynamic default pricing: what a model costs when nobody has set a price.
 *
 * This is a compute market, so the price nobody set should follow the market
 * rather than sit at a number someone typed once. A model served by many idle
 * nodes should get cheaper; a model whose nodes are all saturated should get
 * dearer, because that is the signal that brings more supply online.
 *
 * It only ever replaces the DEFAULT layer. An explicit price still wins:
 *
 *   1. operator  the serving node's own price          (explicit, unchanged)
 *   2. house     the per-model table                    (explicit, unchanged)
 *   3. dynamic   base default x multiplier(supply, demand)   <- this file
 *
 * Four properties this has to have, or it is not fit to charge people with:
 *
 *   bounded      the multiplier is clamped, and the resulting price is clamped
 *                again into the house band, so no market state can produce an
 *                absurd bill
 *   stable       the multiplier is quantized to a step, so two requests a
 *                second apart do not get visibly different prices over noise
 *   explainable  every quote carries the inputs and the multiplier, and that
 *                lands on the receipt. A price nobody can explain is a price
 *                nobody will trust
 *   pure         no I/O here, so the curve is testable and a given market
 *                snapshot always produces the same price
 */

import { usdToMicro } from "./core.js";

export const DEFAULT_DYNAMIC_CONFIG = Object.freeze({
    // On by default (Anthony, 2026-11-05: "it should be dynamic pricing by
    // default based on supply vs. demand of compute").
    dynamic_pricing_enabled: true,
    /**
     * The utilization the price sits at 1.0x. Below it the model is cheaper,
     * above it dearer. 0.5 means "half the fleet busy is the fair price".
     */
    dynamic_target_utilization: 0.5,
    /** How hard the price reacts. 1.5 => full saturation is ~1.75x. */
    dynamic_sensitivity: 1.5,
    /** Never give it away, never gouge. */
    dynamic_min_multiplier: 0.5,
    dynamic_max_multiplier: 3,
    /**
     * A model only one node can serve is fragile supply: nudge it up so the
     * second node is worth bringing online. Added before clamping.
     */
    dynamic_scarcity_boost: 0.25,
    /** Nodes at or below this many serving a model count as scarce. */
    dynamic_scarcity_providers: 1,
    /** Multipliers are rounded to this step, so prices are stable and legible. */
    dynamic_multiplier_step: 0.05
});

function num(v, fallback, { min = -Infinity, max = Infinity } = {}) {
    const n = typeof v === "string" ? Number.parseFloat(v) : v;
    if (!Number.isFinite(n) || n < min || n > max) return fallback;
    return n;
}

function bool(v, fallback) {
    if (v === true || v === "true" || v === "1" || v === 1) return true;
    if (v === false || v === "false" || v === "0" || v === 0) return false;
    return fallback;
}

/** defaults < env < settings row, same contract as the rest of pricing. */
export function resolveDynamicConfig({ env = {}, settings = null } = {}) {
    const d = DEFAULT_DYNAMIC_CONFIG;
    const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    const pick = (key, envKey, opts) => num(s[key], num(env[envKey], d[key], opts), opts);

    const out = {
        dynamic_pricing_enabled: bool(s.dynamic_pricing_enabled, bool(env.INFERNET_DYNAMIC_PRICING, d.dynamic_pricing_enabled)),
        dynamic_target_utilization: pick("dynamic_target_utilization", "INFERNET_DYNAMIC_TARGET", { min: 0, max: 1 }),
        dynamic_sensitivity: pick("dynamic_sensitivity", "INFERNET_DYNAMIC_SENSITIVITY", { min: 0, max: 20 }),
        dynamic_min_multiplier: pick("dynamic_min_multiplier", "INFERNET_DYNAMIC_MIN_MULT", { min: 0.01, max: 100 }),
        dynamic_max_multiplier: pick("dynamic_max_multiplier", "INFERNET_DYNAMIC_MAX_MULT", { min: 0.01, max: 100 }),
        dynamic_scarcity_boost: pick("dynamic_scarcity_boost", "INFERNET_DYNAMIC_SCARCITY_BOOST", { min: 0, max: 10 }),
        dynamic_scarcity_providers: Math.floor(pick("dynamic_scarcity_providers", "INFERNET_DYNAMIC_SCARCITY_PROVIDERS", { min: 0, max: 1000 })),
        dynamic_multiplier_step: pick("dynamic_multiplier_step", "INFERNET_DYNAMIC_STEP", { min: 0.001, max: 1 })
    };
    // A ceiling under the floor is a typo, not a policy.
    if (out.dynamic_max_multiplier < out.dynamic_min_multiplier) {
        out.dynamic_max_multiplier = d.dynamic_max_multiplier > out.dynamic_min_multiplier
            ? d.dynamic_max_multiplier
            : out.dynamic_min_multiplier;
    }
    return out;
}

/**
 * Utilization of the nodes that can serve a model: busy slots over total
 * slots. Can exceed 1 when demand is queued beyond capacity, which is exactly
 * the state the price should react hardest to.
 *
 * `providers` is the live set that serves the model; `inflight` maps provider
 * id to jobs assigned or running right now (lib/routing/smart-pick.js counts
 * it the same way for routing).
 */
export function marketSignal({ providers = [], inflight = {}, capOf, activeOf }) {
    const live = (providers ?? []).filter(Boolean);
    let capacity = 0;
    let busy = 0;
    for (const p of live) {
        capacity += Math.max(0, capOf(p));
        busy += Math.max(0, activeOf(p, inflight));
    }
    return {
        providers: live.length,
        capacity,
        busy,
        // No capacity at all: nothing can serve this, so there is no price
        // signal. The caller answers 503 long before billing matters.
        utilization: capacity > 0 ? busy / capacity : null
    };
}

/** Round to a step, so the price is stable against noise and legible. */
function quantize(v, step) {
    const s = step > 0 ? step : 0.05;
    return Math.round(v / s) * s;
}

/**
 * The multiplier for a market snapshot, plus why.
 *
 * multiplier = 1 + sensitivity x (utilization - target), then a scarcity
 * boost, then quantized, then clamped. Unknown utilization means no signal,
 * which is 1.0x: an unpriced model with no readable market is charged the
 * plain base, never zero and never a guess.
 */
export function dynamicMultiplier({ signal, config }) {
    const c = config;
    if (!c.dynamic_pricing_enabled) {
        return { multiplier: 1, reason: "disabled", utilization: null, providers: signal?.providers ?? 0 };
    }
    const u = signal?.utilization;
    if (u === null || u === undefined || !Number.isFinite(u)) {
        return { multiplier: 1, reason: "no_signal", utilization: null, providers: signal?.providers ?? 0 };
    }

    const raw = 1 + c.dynamic_sensitivity * (u - c.dynamic_target_utilization);
    const scarce = (signal.providers ?? 0) > 0 && (signal.providers ?? 0) <= c.dynamic_scarcity_providers;
    const boosted = raw + (scarce ? c.dynamic_scarcity_boost : 0);
    const stepped = quantize(boosted, c.dynamic_multiplier_step);
    const multiplier = Math.min(Math.max(stepped, c.dynamic_min_multiplier), c.dynamic_max_multiplier);

    return {
        multiplier,
        reason: multiplier === c.dynamic_max_multiplier && stepped > c.dynamic_max_multiplier
            ? "capped"
            : multiplier === c.dynamic_min_multiplier && stepped < c.dynamic_min_multiplier
                ? "floored"
                : u > c.dynamic_target_utilization
                    ? "demand"
                    : u < c.dynamic_target_utilization
                        ? "supply"
                        : "balanced",
        utilization: Math.round(u * 1e4) / 1e4,
        providers: signal.providers ?? 0,
        capacity: signal.capacity ?? 0,
        busy: signal.busy ?? 0,
        scarce
    };
}

/**
 * The dynamic default price for a model: the base default scaled by the
 * market, then clamped into the house band so the market can never produce a
 * price the house would refuse from an operator.
 */
export function dynamicDefaultPrice({ base, signal, config, bounds }) {
    const m = dynamicMultiplier({ signal, config });
    const minB = bounds?.operator_price_min_per_m_usd ?? 0;
    const maxB = bounds?.operator_price_max_per_m_usd ?? Infinity;
    const scale = (v) => {
        const scaled = Math.round(v * m.multiplier * 1e6) / 1e6;
        return Math.min(Math.max(scaled, minB), maxB);
    };
    const input = scale(base.input_per_m_usd);
    const output = scale(base.output_per_m_usd);
    return {
        input_per_m_usd: input,
        output_per_m_usd: output,
        input_micro_per_m: usdToMicro(input),
        output_micro_per_m: usdToMicro(output),
        source: "dynamic",
        dynamic: m,
        base
    };
}
