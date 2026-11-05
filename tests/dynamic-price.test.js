import { describe, it, expect } from "vitest";
import {
    DEFAULT_DYNAMIC_CONFIG,
    resolveDynamicConfig,
    marketSignal,
    dynamicMultiplier,
    dynamicDefaultPrice
} from "../apps/web/lib/billing/dynamic-price.js";
import { capOf, activeOf, DEFAULT_CONCURRENCY_CAP } from "../apps/web/lib/routing/smart-pick.js";
import { DEFAULT_MODEL_PRICE, DEFAULT_OPERATOR_PRICE_BOUNDS } from "../apps/web/lib/billing/operator-prices.js";

const config = resolveDynamicConfig({ env: {} });
const bounds = {
    operator_price_min_per_m_usd: DEFAULT_OPERATOR_PRICE_BOUNDS.operator_price_min_per_m_usd,
    operator_price_max_per_m_usd: DEFAULT_OPERATOR_PRICE_BOUNDS.operator_price_max_per_m_usd
};

/** n nodes, each with `cap` slots and `active` of them busy. */
const fleet = (n, active = 0, cap = DEFAULT_CONCURRENCY_CAP) =>
    Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        specs: { load: { concurrency_cap: cap, active_jobs: active } }
    }));

const signalFor = (providers, inflight = {}) => marketSignal({ providers, inflight, capOf, activeOf });

describe("dynamic pricing is on by default", () => {
    it("defaults to enabled", () => {
        expect(DEFAULT_DYNAMIC_CONFIG.dynamic_pricing_enabled).toBe(true);
        expect(config.dynamic_pricing_enabled).toBe(true);
    });

    it("can be switched off, and then never moves the price", () => {
        const off = resolveDynamicConfig({ env: {}, settings: { dynamic_pricing_enabled: false } });
        const m = dynamicMultiplier({ signal: signalFor(fleet(4, 4)), config: off });
        expect(m.multiplier).toBe(1);
        expect(m.reason).toBe("disabled");
    });

    it("refuses a ceiling below the floor", () => {
        const c = resolveDynamicConfig({ env: {}, settings: { dynamic_min_multiplier: 2, dynamic_max_multiplier: 0.5 } });
        expect(c.dynamic_max_multiplier).toBeGreaterThanOrEqual(c.dynamic_min_multiplier);
    });
});

describe("marketSignal", () => {
    it("reads capacity and busy slots off the live fleet", () => {
        const s = signalFor(fleet(3, 2));
        expect(s.providers).toBe(3);
        expect(s.capacity).toBe(3 * DEFAULT_CONCURRENCY_CAP);
        expect(s.busy).toBe(6);
        expect(s.utilization).toBeCloseTo(6 / 12, 6);
    });

    it("counts live in-flight jobs, not just what the node last reported", () => {
        const providers = fleet(1, 0);
        const s = signalFor(providers, { p0: 3 });
        expect(s.busy).toBe(3);
    });

    it("has no signal at all when nothing serves the model", () => {
        expect(signalFor([]).utilization).toBeNull();
    });
});

describe("the price follows supply and demand", () => {
    it("is cheaper than base when there is spare supply", () => {
        // 4 nodes x 4 slots, 1 busy each = 25% utilized, under the 50% target.
        const m = dynamicMultiplier({ signal: signalFor(fleet(4, 1)), config });
        expect(m.multiplier).toBeLessThan(1);
        expect(m.reason).toBe("supply");
    });

    it("bottoms out at the floor on a completely idle fleet", () => {
        // 1 + 1.5 x (0 - 0.5) = 0.25, which the floor lifts to 0.5. The reason
        // says "floored" rather than "supply" so the quote does not imply the
        // curve produced this number.
        const m = dynamicMultiplier({ signal: signalFor(fleet(4, 0)), config });
        expect(m.multiplier).toBe(config.dynamic_min_multiplier);
        expect(m.reason).toBe("floored");
    });

    it("sits at 1.0x at the target utilization", () => {
        // 4 nodes x 4 slots = 16; half busy = 8.
        const m = dynamicMultiplier({ signal: signalFor(fleet(4, 2)), config });
        expect(m.utilization).toBeCloseTo(0.5, 6);
        expect(m.multiplier).toBeCloseTo(1, 6);
        expect(m.reason).toBe("balanced");
    });

    it("is dearer than base when the fleet is saturated", () => {
        const m = dynamicMultiplier({ signal: signalFor(fleet(4, 4)), config });
        expect(m.utilization).toBeCloseTo(1, 6);
        expect(m.multiplier).toBeGreaterThan(1);
        expect(m.reason).toBe("demand");
    });

    it("rises monotonically with utilization", () => {
        const seen = [0, 1, 2, 3, 4].map(
            (active) => dynamicMultiplier({ signal: signalFor(fleet(4, active)), config }).multiplier
        );
        for (let i = 1; i < seen.length; i += 1) {
            expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
        }
    });

    it("reacts hardest when demand is queued past capacity", () => {
        const saturated = dynamicMultiplier({ signal: signalFor(fleet(2, 4)), config }).multiplier;
        const oversubscribed = dynamicMultiplier({ signal: signalFor(fleet(2, 4), { p0: 20, p1: 20 }), config }).multiplier;
        expect(oversubscribed).toBeGreaterThan(saturated);
    });
});

describe("it is bounded", () => {
    it("never goes below the floor, however idle", () => {
        const m = dynamicMultiplier({ signal: signalFor(fleet(50, 0)), config });
        expect(m.multiplier).toBeGreaterThanOrEqual(config.dynamic_min_multiplier);
    });

    it("never goes above the ceiling, however starved", () => {
        const m = dynamicMultiplier({ signal: signalFor(fleet(1, 4), { p0: 10_000 }), config });
        expect(m.multiplier).toBeLessThanOrEqual(config.dynamic_max_multiplier);
        expect(m.reason).toBe("capped");
    });

    it("keeps the final price inside the house band at any multiplier", () => {
        for (const active of [0, 1, 2, 3, 4, 40]) {
            const p = dynamicDefaultPrice({
                base: DEFAULT_MODEL_PRICE,
                signal: signalFor(fleet(1, active)),
                config,
                bounds
            });
            expect(p.output_per_m_usd).toBeGreaterThanOrEqual(bounds.operator_price_min_per_m_usd);
            expect(p.output_per_m_usd).toBeLessThanOrEqual(bounds.operator_price_max_per_m_usd);
            expect(p.output_micro_per_m).toBeGreaterThan(0);
        }
    });

    it("clamps a base that is itself outside the band", () => {
        const p = dynamicDefaultPrice({
            base: { input_per_m_usd: 500, output_per_m_usd: 900 },
            signal: signalFor(fleet(4, 4)),
            config,
            bounds
        });
        expect(p.output_per_m_usd).toBe(bounds.operator_price_max_per_m_usd);
    });
});

describe("it is stable and explainable", () => {
    it("quantizes, so noise does not move the price", () => {
        // 100 vs 101 busy slots out of 400 is noise, not a price change.
        const a = dynamicMultiplier({ signal: { providers: 100, capacity: 400, busy: 100, utilization: 100 / 400 }, config });
        const b = dynamicMultiplier({ signal: { providers: 100, capacity: 400, busy: 101, utilization: 101 / 400 }, config });
        expect(a.multiplier).toBe(b.multiplier);
    });

    it("is deterministic for a snapshot", () => {
        const s = signalFor(fleet(3, 2));
        expect(dynamicMultiplier({ signal: s, config })).toEqual(dynamicMultiplier({ signal: s, config }));
    });

    it("carries the inputs it priced on, for the receipt", () => {
        const p = dynamicDefaultPrice({ base: DEFAULT_MODEL_PRICE, signal: signalFor(fleet(3, 3)), config, bounds });
        expect(p.source).toBe("dynamic");
        expect(p.dynamic).toMatchObject({ providers: 3, capacity: 12, busy: 9 });
        expect(p.dynamic.utilization).toBeCloseTo(0.75, 4);
        expect(p.dynamic.multiplier).toBeGreaterThan(1);
        expect(p.base).toEqual(DEFAULT_MODEL_PRICE);
    });

    it("charges the plain base when the market cannot be read", () => {
        const p = dynamicDefaultPrice({ base: DEFAULT_MODEL_PRICE, signal: signalFor([]), config, bounds });
        expect(p.dynamic.reason).toBe("no_signal");
        expect(p.dynamic.multiplier).toBe(1);
        expect(p.output_per_m_usd).toBe(DEFAULT_MODEL_PRICE.output_per_m_usd);
    });
});

describe("scarce supply", () => {
    it("nudges a single-node model up, so a second node is worth running", () => {
        const one = dynamicMultiplier({ signal: signalFor(fleet(1, 2)), config });
        const many = dynamicMultiplier({ signal: signalFor(fleet(5, 2)), config });
        expect(one.scarce).toBe(true);
        expect(many.scarce).toBe(false);
        // Same utilization (half busy), but the fragile supply costs more.
        expect(one.utilization).toBeCloseTo(many.utilization, 6);
        expect(one.multiplier).toBeGreaterThan(many.multiplier);
    });

    it("does not call an empty fleet scarce, since there is no price to set", () => {
        expect(dynamicMultiplier({ signal: signalFor([]), config }).scarce).toBeUndefined();
    });
});
