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
