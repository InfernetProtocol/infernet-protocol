import { describe, it, expect } from "vitest";
import {
    DEFAULT_INTERACTIVE_CONFIG,
    DEFAULT_INTERACTIVE_HOUSE_FEE_PCT,
    resolveInteractiveConfig,
    interactiveModeFor,
    priceInteractive,
    spendableMicro,
    chargeIdemKey,
    withMinCharge,
    adminFallback
} from "../apps/web/lib/billing/interactive.js";
import { DEFAULT_INFERENCE_PRICING, resolveInferencePricing, MICRO, providerSplitMicro } from "../apps/web/lib/billing/core.js";

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


describe("house fee on an interactive charge", () => {
    it("defaults to 5%, so the provider keeps 95% of what was collected", () => {
        expect(DEFAULT_INTERACTIVE_HOUSE_FEE_PCT).toBe(5);
        expect(resolveInteractiveConfig({ env: {} }).house_fee_pct).toBe(5);
        const { feeMicro, providerMicro } = providerSplitMicro(1000, 5);
        expect(feeMicro).toBe(50);
        expect(providerMicro).toBe(950);
    });

    it("is overridable by env and settings, and rejects an out-of-range typo", () => {
        expect(resolveInteractiveConfig({ env: { INFERNET_INTERACTIVE_HOUSE_FEE_PCT: "35" } }).house_fee_pct).toBe(35);
        expect(resolveInteractiveConfig({ env: {}, settings: { house_fee_pct: 10 } }).house_fee_pct).toBe(10);
        expect(resolveInteractiveConfig({ env: {}, settings: { house_fee_pct: 900 } }).house_fee_pct).toBe(5);
        expect(resolveInteractiveConfig({ env: {}, settings: { house_fee_pct: -5 } }).house_fee_pct).toBe(5);
    });

    it("never pays a provider more than the customer paid, at any fee", () => {
        for (const fee of [0, 1, 20, 50, 99.99, 100]) {
            for (const charge of [1, 7, 999, 1_000_000]) {
                const { feeMicro, providerMicro } = providerSplitMicro(charge, fee);
                expect(feeMicro + providerMicro).toBe(charge);
                expect(providerMicro).toBeLessThanOrEqual(charge);
                expect(providerMicro).toBeGreaterThanOrEqual(0);
            }
        }
    });

    /**
     * The bug this guards: a billed interactive job has payment_offer 0 and no
     * batch item, so the ordinary completion path would credit it the FREE-TIER
     * subsidy ($0.01 per 1k output = $10 per 1M) while the customer paid the
     * table price ($0.20 per 1M output on qwen2.5:7b) - about fifty times the
     * sale price, paid out on every chat.
     */
    it("would lose money if a billed job were paid at the subsidy rate", () => {
        const outputTokens = 1_000_000;
        const subsidyPer1k = 0.01; // the live 'earnings' setting
        const subsidyUsd = (outputTokens / 1000) * subsidyPer1k;
        const saleUsd = outputTokens * DEFAULT_INFERENCE_PRICING.models["qwen2.5:7b"].output_per_m_usd / 1_000_000;
        expect(subsidyUsd).toBeGreaterThan(saleUsd * 10);

        // Paid from the charge instead, the house is never underwater.
        const chargeMicro = Math.round(saleUsd * MICRO);
        const { providerMicro } = providerSplitMicro(chargeMicro, DEFAULT_INTERACTIVE_HOUSE_FEE_PCT);
        expect(providerMicro).toBeLessThan(chargeMicro);
    });
});

describe("adminFallback", () => {
    const paid = { mode: "balance", reason: "balance", spendable_micro: 5_000_000 };

    it("an admin with a balance pays like anyone, so the node is paid", () => {
        expect(adminFallback({ isAdmin: true, decision: paid })).toBe(paid);
    });

    it("an admin whose balance cannot pay runs unmetered, never free tier or 402", () => {
        for (const mode of ["insufficient", "free"]) {
            const out = adminFallback({ isAdmin: true, decision: { mode, reason: "empty", spendable_micro: 0 } });
            expect(out.mode).toBe("admin");
            expect(out.spendable_micro).toBe(0);
        }
    });

    it("leaves everyone else's decision alone", () => {
        const insufficient = { mode: "insufficient", reason: "empty" };
        expect(adminFallback({ isAdmin: false, decision: insufficient })).toBe(insufficient);
        expect(adminFallback({ isAdmin: false, decision: paid })).toBe(paid);
    });
});

describe("per-job minimum charge", () => {
    it("defaults to $0.001 and can be set or turned off", () => {
        expect(resolveInteractiveConfig({ env: {} }).min_charge_usd).toBe(0.001);
        expect(resolveInteractiveConfig({ env: {}, settings: { min_charge_usd: 0.002 } }).min_charge_usd).toBe(0.002);
        expect(resolveInteractiveConfig({ env: { INFERNET_INTERACTIVE_MIN_CHARGE_USD: "0" } }).min_charge_usd).toBe(0);
        expect(resolveInteractiveConfig({ env: {}, settings: { min_charge_usd: -1 } }).min_charge_usd).toBe(0.001);
    });

    it("floors a short chat at the minimum and leaves a costlier one alone", () => {
        const cfg = resolveInteractiveConfig({ env: {} });
        expect(withMinCharge(45, cfg)).toBe(1000);
        expect(withMinCharge(2500, cfg)).toBe(2500);
        expect(withMinCharge(0, cfg)).toBe(0);
        expect(withMinCharge(45, { ...cfg, min_charge_usd: 0 })).toBe(45);
    });
});
