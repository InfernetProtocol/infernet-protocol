/**
 * Who sets the price of a model, and what it is when nobody has.
 *
 * Three layers, highest wins:
 *
 *   1. operator  the node's own price for that model (this file)
 *   2. house     the per-model table in the `inference_pricing` settings row
 *   3. default   `default_model_price`, so a model NOBODY has priced still
 *                costs something
 *
 * Layer 3 is the point. Before it, a model missing from the house table was
 * served free (`free_when_unpriced`), so every model added to the network -
 * including our own fine-tunes - gave compute away until someone remembered to
 * price it. A default means adding a model is never an accidental giveaway.
 *
 * Layer 1 is bounded by the house (`operator_price_min/max_per_m_usd`): an
 * operator price outside the band is refused when they set it, AND clamped
 * when it is read, so narrowing the band later cannot leave a stale price
 * outside it. Without that, one node could price absurdly and poison both the
 * margin and any cheapest-first routing built on these numbers.
 */

import { usdToMicro, microToUsd } from "./core.js";

/** Prices are per 1M tokens, in USD, same unit as the house table. */
export const DEFAULT_MODEL_PRICE = Object.freeze({
    // A middling small-model price: more than the 0.5b floor, less than 7b. A
    // new model is usually small, and guessing low loses money while guessing
    // high turns a new model into a bill shock.
    input_per_m_usd: 0.03,
    output_per_m_usd: 0.12
});

/**
 * The band an operator price must sit in. Wide enough to be a real market,
 * narrow enough that nothing is free and nothing is absurd.
 */
export const DEFAULT_OPERATOR_PRICE_BOUNDS = Object.freeze({
    operator_pricing_enabled: true,
    operator_price_min_per_m_usd: 0.005,
    operator_price_max_per_m_usd: 2
});

function price(v) {
    const n = typeof v === "string" ? Number.parseFloat(v) : v;
    if (!Number.isFinite(n) || n < 0 || n > 1000) return null;
    // At most 6 decimals, the precision usdToMicro accepts.
    return Math.round(n * 1e6) / 1e6;
}

/** A {input_per_m_usd, output_per_m_usd} pair, or null if either is unusable. */
export function cleanPricePair(p) {
    const i = price(p?.input_per_m_usd);
    const o = price(p?.output_per_m_usd);
    if (i === null || o === null) return null;
    return { input_per_m_usd: i, output_per_m_usd: o };
}

/** Resolve the default + bounds from the pricing settings row. */
export function resolvePriceDefaults({ env = {}, settings = null } = {}) {
    const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    const fromEnv = cleanPricePair({
        input_per_m_usd: env.INFERNET_DEFAULT_MODEL_INPUT_PER_M_USD,
        output_per_m_usd: env.INFERNET_DEFAULT_MODEL_OUTPUT_PER_M_USD
    });
    const def = cleanPricePair(s.default_model_price) ?? fromEnv ?? DEFAULT_MODEL_PRICE;

    const d = DEFAULT_OPERATOR_PRICE_BOUNDS;
    const min = price(s.operator_price_min_per_m_usd) ?? price(env.INFERNET_OPERATOR_PRICE_MIN) ?? d.operator_price_min_per_m_usd;
    let max = price(s.operator_price_max_per_m_usd) ?? price(env.INFERNET_OPERATOR_PRICE_MAX) ?? d.operator_price_max_per_m_usd;
    // A max below the min is a typo, not a policy: fall back rather than
    // making every operator price impossible.
    if (max < min) max = d.operator_price_max_per_m_usd > min ? d.operator_price_max_per_m_usd : min;

    const enabled =
        s.operator_pricing_enabled === undefined
            ? (env.INFERNET_OPERATOR_PRICING === undefined
                ? d.operator_pricing_enabled
                : !(env.INFERNET_OPERATOR_PRICING === "false" || env.INFERNET_OPERATOR_PRICING === "0"))
            : s.operator_pricing_enabled !== false;

    return {
        default_model_price: def,
        operator_pricing_enabled: enabled,
        operator_price_min_per_m_usd: min,
        operator_price_max_per_m_usd: max
    };
}

/** True while `v` is inside the house band. */
export function withinBounds(v, defaults) {
    const n = price(v);
    if (n === null) return false;
    return n >= defaults.operator_price_min_per_m_usd && n <= defaults.operator_price_max_per_m_usd;
}

/**
 * Validate an operator's proposed price. Refused rather than clamped: an
 * operator asking for a price we will not honour should be told so, not
 * silently given a different one.
 */
export function checkOperatorPrice(input, defaults) {
    if (!defaults.operator_pricing_enabled) {
        return { ok: false, error: "operator pricing is switched off on this network" };
    }
    const pair = cleanPricePair(input);
    if (!pair) {
        return { ok: false, error: "input_per_m_usd and output_per_m_usd are required, each 0-1000 with at most 6 decimals" };
    }
    const { operator_price_min_per_m_usd: min, operator_price_max_per_m_usd: max } = defaults;
    for (const [field, v] of [["input_per_m_usd", pair.input_per_m_usd], ["output_per_m_usd", pair.output_per_m_usd]]) {
        if (v < min || v > max) {
            return {
                ok: false,
                error: `${field} must be between ${min} and ${max} USD per 1M tokens on this network`,
                bounds: { min, max }
            };
        }
    }
    return { ok: true, value: pair };
}

/** Clamp a stored price into the band, for reads. Returns {pair, clamped}. */
export function clampToBounds(pair, defaults) {
    const { operator_price_min_per_m_usd: min, operator_price_max_per_m_usd: max } = defaults;
    const fix = (v) => Math.min(Math.max(v, min), max);
    const out = { input_per_m_usd: fix(pair.input_per_m_usd), output_per_m_usd: fix(pair.output_per_m_usd) };
    const clamped = out.input_per_m_usd !== pair.input_per_m_usd || out.output_per_m_usd !== pair.output_per_m_usd;
    return { pair: out, clamped };
}

/**
 * The price a job is actually charged at, and where it came from.
 *
 * `operatorPrice` is the serving node's own price for this model, if it has
 * one. It is clamped on read, so a band narrowed after the fact still holds.
 *
 * Returns { input_micro_per_m, output_micro_per_m, source, clamped }, source
 * being "operator" | "house" | "default".
 */
export function effectivePrice({ model, pricing, defaults, operatorPrice = null, dynamic = null }) {
    const toMicro = (pair, source, clamped = false) => ({
        input_micro_per_m: usdToMicro(pair.input_per_m_usd),
        output_micro_per_m: usdToMicro(pair.output_per_m_usd),
        input_per_m_usd: pair.input_per_m_usd,
        output_per_m_usd: pair.output_per_m_usd,
        source,
        clamped
    });

    if (defaults.operator_pricing_enabled && operatorPrice) {
        const pair = cleanPricePair(operatorPrice);
        if (pair) {
            const { pair: bounded, clamped } = clampToBounds(pair, defaults);
            return toMicro(bounded, "operator", clamped);
        }
    }

    // No operator price: the house rate card for this model, else the house
    // default. Whichever it is becomes the BASE, and the market scales it.
    const house = cleanPricePair(pricing?.models?.[model]);
    const base = house ?? cleanPricePair(defaults.default_model_price) ?? DEFAULT_MODEL_PRICE;
    const baseSource = house ? "house" : "default";

    // Dynamic pricing applies to the house rate card as well as the default,
    // not only to unpriced models. Applying it to the default alone made it
    // dead code the moment every live model was priced, and pricing off a
    // single base would have thrown away the per-model-size differences the
    // rate card exists to express. An OPERATOR's own price is never scaled:
    // they set that number deliberately.
    if (dynamic?.scale) {
        const scaled = dynamic.scale(base);
        if (scaled) return { ...scaled, base_source: baseSource };
    }
    return toMicro(base, baseSource);
}

/** Display helper: the three layers for one model, for the API and the CLI. */
export function describePrice({ model, pricing, defaults, operatorPrice = null, dynamic = null }) {
    const eff = effectivePrice({ model, pricing, defaults, operatorPrice, dynamic });
    return {
        model,
        input_per_m_usd: eff.input_per_m_usd,
        output_per_m_usd: eff.output_per_m_usd,
        source: eff.source,
        clamped: eff.clamped,
        house: cleanPricePair(pricing?.models?.[model]) ?? null,
        default: cleanPricePair(defaults.default_model_price) ?? DEFAULT_MODEL_PRICE,
        bounds: {
            min_per_m_usd: defaults.operator_price_min_per_m_usd,
            max_per_m_usd: defaults.operator_price_max_per_m_usd
        },
        per_1k_output_usd: microToUsd(Math.round(eff.output_micro_per_m / 1000)),
        // The market move AND the base it was applied to. Without the base, a
        // caller can see a multiplier and a final price but cannot check one
        // against the other, which is most of the point of publishing it.
        ...(eff.dynamic
            ? {
                dynamic: {
                    ...eff.dynamic,
                    base: eff.base ?? null,
                    base_source: eff.base_source ?? null
                }
            }
            : {})
    };
}
