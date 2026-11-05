import { describe, it, expect } from "vitest";
import {
    DEFAULT_INTERACTIVE_CONFIG,
    resolveInteractiveConfig,
    interactiveModeFor,
    priceInteractive,
    spendableMicro,
    chargeIdemKey
} from "../apps/web/lib/billing/interactive.js";
import { DEFAULT_INFERENCE_PRICING, resolveInferencePricing, MICRO } from "../apps/web/lib/billing/core.js";

const pricing = resolveInferencePricing({ env: {} });
const on = resolveInteractiveConfig({ env: {}, settings: { enabled: true } });
const off = resolveInteractiveConfig({ env: {} });

const funding = (prepaid, earned = 0) => ({
    prepaid_available_micro: prepaid,
    earned_spendable_micro: earned
});

describe("interactive config", () => {
    it("is off by default, so deploying it charges nobody", () => {
        expect(DEFAULT_INTERACTIVE_CONFIG.enabled).toBe(false);
        expect(off.enabled).toBe(false);
    });

    it("keeps the free tier and earned spending on by default", () => {
        expect(off.free_tier_when_empty).toBe(true);
        expect(off.spend_earned).toBe(true);
        expect(off.free_when_unpriced).toBe(true);
    });

    it("layers settings over env", () => {
        const c = resolveInteractiveConfig({
            env: { INFERNET_INTERACTIVE_BILLING: "true", INFERNET_INTERACTIVE_SPEND_EARNED: "false" },
            settings: { spend_earned: true }
        });
        expect(c.enabled).toBe(true);
        expect(c.spend_earned).toBe(true);
    });
});

describe("spendableMicro", () => {
    it("adds node earnings to the prepaid balance", () => {
        expect(spendableMicro({ funding: funding(1000, 2500), config: on })).toBe(3500);
    });

    it("ignores earnings when spending them is switched off", () => {
        const noEarned = resolveInteractiveConfig({ env: {}, settings: { enabled: true, spend_earned: false } });
        expect(spendableMicro({ funding: funding(1000, 2500), config: noEarned })).toBe(1000);
    });

    it("never goes negative on junk", () => {
        expect(spendableMicro({ funding: { prepaid_available_micro: -5 }, config: on })).toBe(0);
        expect(spendableMicro({ funding: null, config: on })).toBe(0);
    });
});

describe("interactiveModeFor", () => {
    const model = "qwen2.5:7b";

    it("leaves everyone free while metering is off", () => {
        expect(interactiveModeFor({ model, pricing, config: off, funding: funding(0) }).mode).toBe("free");
        expect(interactiveModeFor({ model, pricing, config: off, funding: funding(999999) }).mode).toBe("free");
    });

    it("never bills an anonymous caller", () => {
        expect(interactiveModeFor({ model, pricing, config: on, funding: funding(500), signedIn: false }).mode).toBe("free");
    });

    it("charges a caller with a prepaid balance", () => {
        expect(interactiveModeFor({ model, pricing, config: on, funding: funding(500) }).mode).toBe("balance");
    });

    it("charges a caller whose only funds are what their nodes earned", () => {
        const d = interactiveModeFor({ model, pricing, config: on, funding: funding(0, 1200) });
        expect(d.mode).toBe("balance");
        expect(d.spendable_micro).toBe(1200);
    });

    it("falls back to the free tier on an empty balance", () => {
        expect(interactiveModeFor({ model, pricing, config: on, funding: funding(0) }).mode).toBe("free");
    });

    it("402s on empty only once the free tier is switched off", () => {
        const strict = resolveInteractiveConfig({ env: {}, settings: { enabled: true, free_tier_when_empty: false } });
        expect(interactiveModeFor({ model, pricing, config: strict, funding: funding(0) }).mode).toBe("insufficient");
    });

    it("serves an unpriced model free rather than refusing it", () => {
        const d = interactiveModeFor({ model: "some-new-model:70b", pricing, config: on, funding: funding(5000) });
        expect(d.mode).toBe("free");
        expect(d.reason).toBe("unpriced_model");
    });

    it("stays free while pricing itself is disabled", () => {
        const disabled = resolveInferencePricing({ env: {}, settings: { enabled: false } });
        expect(interactiveModeFor({ model, pricing: disabled, config: on, funding: funding(5000) }).mode).toBe("free");
    });
});

describe("priceInteractive", () => {
    const model = "qwen2.5:7b";
    const price = DEFAULT_INFERENCE_PRICING.models[model];

    it("prices on the same table paid batches use", () => {
        // 4 chars per token: 4000 chars in, 400 chars out.
        const q = priceInteractive({
            model,
            pricing,
            messages: [{ role: "user", content: "x".repeat(4000) }],
            result: { text: "y".repeat(400) },
            maxTokens: 512
        });
        expect(q.priced).toBe(true);
        expect(q.input_tokens).toBe(1000);
        expect(q.output_tokens).toBe(100);
        const expected = Math.ceil(
            (1000 * price.input_per_m_usd * MICRO + 100 * price.output_per_m_usd * MICRO) / 1_000_000
        );
        expect(q.cost_micro).toBe(expected);
    });

    it("clamps output to max_tokens so a long reply cannot exceed the quote", () => {
        const q = priceInteractive({
            model,
            pricing,
            messages: [{ role: "user", content: "hi" }],
            result: { text: "y".repeat(100_000) },
            maxTokens: 10
        });
        expect(q.output_tokens).toBe(10);
    });

    it("is not priced at all for an unknown model", () => {
        const q = priceInteractive({ model: "nope:1b", pricing, messages: [], result: { text: "hi" } });
        expect(q.priced).toBe(false);
        expect(q.cost_micro).toBe(0);
    });

    it("costs nothing when the model produced nothing", () => {
        const q = priceInteractive({ model, pricing, messages: [], result: { text: "" }, maxTokens: 100 });
        expect(q.cost_micro).toBe(0);
    });

    it("keeps a short chat well under a cent", () => {
        const q = priceInteractive({
            model,
            pricing,
            messages: [{ role: "user", content: "what is 2+2?" }],
            result: { text: "4" },
            maxTokens: 64
        });
        expect(q.cost_micro).toBeGreaterThan(0);
        expect(q.cost_micro).toBeLessThan(10_000); // under one cent
    });
});

describe("chargeIdemKey", () => {
    it("is one key per job, which is what stops a double charge", () => {
        expect(chargeIdemKey("abc")).toBe("job:abc:charge");
        expect(chargeIdemKey("abc")).toBe(chargeIdemKey("abc"));
        expect(chargeIdemKey("abc")).not.toBe(chargeIdemKey("abd"));
    });
});
