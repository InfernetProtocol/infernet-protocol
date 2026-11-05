import { describe, it, expect } from "vitest";
import {
    DEFAULT_MODEL_PRICE,
    DEFAULT_OPERATOR_PRICE_BOUNDS,
    resolvePriceDefaults,
    cleanPricePair,
    checkOperatorPrice,
    clampToBounds,
    withinBounds,
    effectivePrice,
    describePrice
} from "../apps/web/lib/billing/operator-prices.js";
import { resolveInferencePricing, usdToMicro } from "../apps/web/lib/billing/core.js";
import { resolveDynamicConfig, scaleByMarket } from "../apps/web/lib/billing/dynamic-price.js";

const pricing = resolveInferencePricing({ env: {} });
const defaults = resolvePriceDefaults({ env: {} });

describe("a model nobody priced is never free", () => {
    it("falls back to the house default", () => {
        const p = effectivePrice({ model: "brand-new-model:70b", pricing, defaults });
        expect(p.source).toBe("default");
        expect(p.output_micro_per_m).toBe(usdToMicro(DEFAULT_MODEL_PRICE.output_per_m_usd));
        expect(p.output_micro_per_m).toBeGreaterThan(0);
    });

    it("still charges when the house table is completely empty", () => {
        const empty = resolveInferencePricing({ env: {}, settings: { models: {} } });
        const p = effectivePrice({ model: "anything", pricing: empty, defaults });
        expect(p.source).toBe("default");
        expect(p.input_micro_per_m).toBeGreaterThan(0);
    });

    it("prefers the house price over the default when there is one", () => {
        const p = effectivePrice({ model: "qwen2.5:7b", pricing, defaults });
        expect(p.source).toBe("house");
        expect(p.output_per_m_usd).toBe(0.2);
    });

    it("takes the default from settings when the house sets one", () => {
        const d = resolvePriceDefaults({ env: {}, settings: { default_model_price: { input_per_m_usd: 0.07, output_per_m_usd: 0.28 } } });
        expect(effectivePrice({ model: "x", pricing, defaults: d }).output_per_m_usd).toBe(0.28);
    });

    it("ignores a malformed default rather than becoming free", () => {
        const d = resolvePriceDefaults({ env: {}, settings: { default_model_price: { input_per_m_usd: "junk" } } });
        expect(d.default_model_price).toEqual(DEFAULT_MODEL_PRICE);
    });
});

describe("an operator's own price wins", () => {
    it("beats both the house price and the default", () => {
        const p = effectivePrice({
            model: "qwen2.5:7b",
            pricing,
            defaults,
            operatorPrice: { input_per_m_usd: 0.1, output_per_m_usd: 0.4 }
        });
        expect(p.source).toBe("operator");
        expect(p.output_per_m_usd).toBe(0.4);
    });

    it("is ignored while operator pricing is switched off network-wide", () => {
        const off = resolvePriceDefaults({ env: {}, settings: { operator_pricing_enabled: false } });
        const p = effectivePrice({
            model: "qwen2.5:7b",
            pricing,
            defaults: off,
            operatorPrice: { input_per_m_usd: 0.1, output_per_m_usd: 0.4 }
        });
        expect(p.source).toBe("house");
    });

    it("is ignored when it is malformed, rather than making the job free", () => {
        const p = effectivePrice({ model: "qwen2.5:7b", pricing, defaults, operatorPrice: { input_per_m_usd: null } });
        expect(p.source).toBe("house");
        expect(p.output_micro_per_m).toBeGreaterThan(0);
    });
});

describe("the house band", () => {
    it("defaults to a real but bounded range", () => {
        expect(defaults.operator_price_min_per_m_usd).toBe(DEFAULT_OPERATOR_PRICE_BOUNDS.operator_price_min_per_m_usd);
        expect(defaults.operator_price_max_per_m_usd).toBe(DEFAULT_OPERATOR_PRICE_BOUNDS.operator_price_max_per_m_usd);
        expect(defaults.operator_price_min_per_m_usd).toBeGreaterThan(0);
    });

    it("refuses a price under the floor or over the ceiling", () => {
        expect(checkOperatorPrice({ input_per_m_usd: 0, output_per_m_usd: 0 }, defaults).ok).toBe(false);
        expect(checkOperatorPrice({ input_per_m_usd: 0.05, output_per_m_usd: 999 }, defaults).ok).toBe(false);
        const refused = checkOperatorPrice({ input_per_m_usd: 0.05, output_per_m_usd: 999 }, defaults);
        expect(refused.error).toMatch(/output_per_m_usd/);
        expect(refused.bounds).toEqual({ min: defaults.operator_price_min_per_m_usd, max: defaults.operator_price_max_per_m_usd });
    });

    it("accepts a price inside it", () => {
        const ok = checkOperatorPrice({ input_per_m_usd: 0.05, output_per_m_usd: 0.18 }, defaults);
        expect(ok).toEqual({ ok: true, value: { input_per_m_usd: 0.05, output_per_m_usd: 0.18 } });
    });

    it("refuses everything while operator pricing is off", () => {
        const off = resolvePriceDefaults({ env: {}, settings: { operator_pricing_enabled: false } });
        expect(checkOperatorPrice({ input_per_m_usd: 0.05, output_per_m_usd: 0.18 }, off).ok).toBe(false);
    });

    it("clamps a stored price when the band is narrowed afterwards", () => {
        // An operator priced at 1.50 while the ceiling was 2.00; the house then
        // drops the ceiling to 0.50. The stored row must not escape the band.
        const narrowed = resolvePriceDefaults({ env: {}, settings: { operator_price_max_per_m_usd: 0.5 } });
        const stored = { input_per_m_usd: 1.5, output_per_m_usd: 1.5 };
        expect(withinBounds(stored.output_per_m_usd, narrowed)).toBe(false);
        const { pair, clamped } = clampToBounds(stored, narrowed);
        expect(clamped).toBe(true);
        expect(pair.output_per_m_usd).toBe(0.5);

        const p = effectivePrice({ model: "qwen2.5:7b", pricing, defaults: narrowed, operatorPrice: stored });
        expect(p.source).toBe("operator");
        expect(p.clamped).toBe(true);
        expect(p.output_per_m_usd).toBe(0.5);
    });

    it("clamps up to the floor too, so nothing is sold for nothing", () => {
        const d = resolvePriceDefaults({ env: {}, settings: { operator_price_min_per_m_usd: 0.02 } });
        const p = effectivePrice({ model: "m", pricing, defaults: d, operatorPrice: { input_per_m_usd: 0, output_per_m_usd: 0 } });
        expect(p.output_per_m_usd).toBe(0.02);
        expect(p.output_micro_per_m).toBeGreaterThan(0);
    });

    it("falls back rather than accepting a ceiling below the floor", () => {
        const d = resolvePriceDefaults({ env: {}, settings: { operator_price_min_per_m_usd: 1, operator_price_max_per_m_usd: 0.1 } });
        expect(d.operator_price_max_per_m_usd).toBeGreaterThanOrEqual(d.operator_price_min_per_m_usd);
    });
});

describe("cleanPricePair", () => {
    it("rejects junk, negatives and absurd values", () => {
        expect(cleanPricePair(null)).toBeNull();
        expect(cleanPricePair({ input_per_m_usd: -1, output_per_m_usd: 1 })).toBeNull();
        expect(cleanPricePair({ input_per_m_usd: 1, output_per_m_usd: 100000 })).toBeNull();
        expect(cleanPricePair({ input_per_m_usd: "0.05", output_per_m_usd: "0.2" })).toEqual({
            input_per_m_usd: 0.05,
            output_per_m_usd: 0.2
        });
    });
});

describe("describePrice", () => {
    it("shows the effective price, its source, and the layers behind it", () => {
        const d = describePrice({
            model: "qwen2.5:7b",
            pricing,
            defaults,
            operatorPrice: { input_per_m_usd: 0.06, output_per_m_usd: 0.24 }
        });
        expect(d).toMatchObject({ model: "qwen2.5:7b", source: "operator", output_per_m_usd: 0.24 });
        expect(d.house).toEqual({ input_per_m_usd: 0.05, output_per_m_usd: 0.2 });
        expect(d.bounds.max_per_m_usd).toBe(defaults.operator_price_max_per_m_usd);
    });
});


/**
 * The settings row carries keys resolveInferencePricing does not model
 * (default_model_price, the operator band). updateInferencePricing used to
 * rebuild the row from that resolver alone, which silently DROPPED them: the
 * first time the band was set in production it vanished, and the house could
 * not change its own cap. These pin the read side of that contract - a row
 * that still holds the keys must resolve to them, and a malformed one must
 * fall back instead of being trusted.
 */
describe("the settings row round-trips the default and the band", () => {
    it("reads back what the house stored", () => {
        const stored = {
            enabled: true,
            models: {},
            default_model_price: { input_per_m_usd: 0.04, output_per_m_usd: 0.16 },
            operator_pricing_enabled: true,
            operator_price_min_per_m_usd: 0.01,
            operator_price_max_per_m_usd: 0.75
        };
        const d = resolvePriceDefaults({ env: {}, settings: stored });
        expect(d.default_model_price).toEqual({ input_per_m_usd: 0.04, output_per_m_usd: 0.16 });
        expect(d.operator_price_min_per_m_usd).toBe(0.01);
        expect(d.operator_price_max_per_m_usd).toBe(0.75);
        expect(d.operator_pricing_enabled).toBe(true);

        // And the band it read is the band it enforces.
        expect(checkOperatorPrice({ input_per_m_usd: 0.5, output_per_m_usd: 0.9 }, d).ok).toBe(false);
        expect(checkOperatorPrice({ input_per_m_usd: 0.02, output_per_m_usd: 0.7 }, d).ok).toBe(true);
    });

    it("falls back to the code default when the row lost those keys", () => {
        // Exactly the shape production had after the keys were stripped.
        const stripped = { enabled: true, models: {}, min_topup_usd: 5, max_in_flight: 8 };
        const d = resolvePriceDefaults({ env: {}, settings: stripped });
        expect(d.default_model_price).toEqual(DEFAULT_MODEL_PRICE);
        expect(d.operator_price_max_per_m_usd).toBe(DEFAULT_OPERATOR_PRICE_BOUNDS.operator_price_max_per_m_usd);
        // Still never free.
        expect(effectivePrice({ model: "whatever", pricing: { models: {} }, defaults: d }).output_micro_per_m).toBeGreaterThan(0);
    });

    it("honours operator pricing being switched off in the row", () => {
        const d = resolvePriceDefaults({ env: {}, settings: { operator_pricing_enabled: false } });
        expect(d.operator_pricing_enabled).toBe(false);
        expect(checkOperatorPrice({ input_per_m_usd: 0.05, output_per_m_usd: 0.2 }, d).ok).toBe(false);
    });
});


/**
 * How the market interacts with the three layers.
 *
 * The first cut applied the market only to models nobody had priced. That made
 * it dead code the moment every live model was in the rate card (which is
 * exactly what happened: all 12 served models read source "house"), and
 * pricing everything off a single base would have thrown away the per-model
 * size differences the card exists to express. So the market SCALES whichever
 * base applies - but never an operator's own price.
 */
describe("the market scales the base, it does not replace it", () => {
    const dynConfig = resolveDynamicConfig({ env: {} });
    // A saturated single-node fleet: a clearly above-1 multiplier.
    const hot = { providers: 4, capacity: 16, busy: 16, utilization: 1 };
    const market = (bounds) => ({ scale: scaleByMarket({ signal: hot, config: dynConfig, bounds }) });

    it("scales the house rate card, so size differences survive", () => {
        const dyn = market(defaults);
        const small = effectivePrice({ model: "qwen2.5:0.5b", pricing, defaults, dynamic: dyn });
        const large = effectivePrice({ model: "qwen2.5:7b", pricing, defaults, dynamic: dyn });

        // Both moved off the card...
        expect(small.source).toBe("dynamic");
        expect(small.output_per_m_usd).toBeGreaterThan(0.04);
        expect(large.output_per_m_usd).toBeGreaterThan(0.2);
        // ...and the 7b is still dearer than the 0.5b.
        expect(large.output_per_m_usd).toBeGreaterThan(small.output_per_m_usd);
        // The card it scaled is recorded, so the quote is explainable.
        expect(small.base).toEqual({ input_per_m_usd: 0.01, output_per_m_usd: 0.04 });
        expect(small.base_source).toBe("house");
    });

    it("scales the default for a model with no card", () => {
        const p = effectivePrice({ model: "brand-new:1b", pricing, defaults, dynamic: market(defaults) });
        expect(p.source).toBe("dynamic");
        expect(p.base_source).toBe("default");
        expect(p.output_per_m_usd).toBeGreaterThan(DEFAULT_MODEL_PRICE.output_per_m_usd);
    });

    it("never scales an operator's own price", () => {
        const own = { input_per_m_usd: 0.06, output_per_m_usd: 0.24 };
        const p = effectivePrice({ model: "qwen2.5:7b", pricing, defaults, operatorPrice: own, dynamic: market(defaults) });
        expect(p.source).toBe("operator");
        // Exactly what they set, untouched by the market.
        expect(p.output_per_m_usd).toBe(0.24);
    });

    it("still clamps the scaled price into the house band", () => {
        const narrow = resolvePriceDefaults({ env: {}, settings: { operator_price_max_per_m_usd: 0.1 } });
        const p = effectivePrice({ model: "qwen2.5:7b", pricing, defaults: narrow, dynamic: market(narrow) });
        expect(p.output_per_m_usd).toBeLessThanOrEqual(0.1);
    });

    it("leaves the card alone when there is no market to read", () => {
        const noSignal = { scale: scaleByMarket({ signal: { providers: 0, capacity: 0, utilization: null }, config: dynConfig, bounds: defaults }) };
        const p = effectivePrice({ model: "qwen2.5:7b", pricing, defaults, dynamic: noSignal });
        expect(p.output_per_m_usd).toBe(0.2);
        expect(p.dynamic.reason).toBe("no_signal");
    });
});
