import { describe, expect, it } from "vitest";
import { effectivePrice, describePrice } from "../apps/web/lib/billing/operator-prices.js";
import { DEFAULT_INFERENCE_PRICING, resolveInferencePricing } from "../apps/web/lib/billing/core.js";
import { FEATURED_MODEL, perChatUsd, breakEvenChatsPerDay } from "../apps/web/lib/pricing/featured.js";

// Anthony, 2026-11-18: make the GPU 9B pay for its GPU (~$0.005 a chat).
const defaults = {
    operator_pricing_enabled: true,
    operator_price_min_per_m_usd: 0.005,
    operator_price_max_per_m_usd: 2,
    default_model_price: { input_per_m_usd: 0.03, output_per_m_usd: 0.12 }
};
const halfPrice = { scale: (b) => ({ input_per_m_usd: b.input_per_m_usd / 2, output_per_m_usd: b.output_per_m_usd / 2, input_micro_per_m: 1, output_micro_per_m: 1, source: "dynamic" }) };

describe("the GPU 9B list price", () => {
    it("is a fixed house price: the market multiplier never scales it", () => {
        const e = effectivePrice({ model: FEATURED_MODEL.id, pricing: DEFAULT_INFERENCE_PRICING, defaults, dynamic: halfPrice });
        expect(e).toMatchObject({ input_per_m_usd: 2, output_per_m_usd: 8, source: "house", fixed: true });
        expect(describePrice({ model: FEATURED_MODEL.id, pricing: DEFAULT_INFERENCE_PRICING, defaults, dynamic: halfPrice }).fixed).toBe(true);
        // Other house prices still follow the market.
        expect(effectivePrice({ model: "qwen2.5:7b", pricing: DEFAULT_INFERENCE_PRICING, defaults, dynamic: halfPrice }).source).toBe("dynamic");
    });

    it("the settings row keeps `fixed` (it was stripped in 0.1.102, so the market still halved the price)", () => {
        const live = resolveInferencePricing({ env: {}, settings: { models: { [FEATURED_MODEL.id]: { input_per_m_usd: 2, output_per_m_usd: 8, fixed: true }, "qwen2.5:7b": { input_per_m_usd: 0.05, output_per_m_usd: 0.2 } } } });
        expect(live.models[FEATURED_MODEL.id].fixed).toBe(true);
        expect(live.models["qwen2.5:7b"].fixed).toBeUndefined();
        expect(effectivePrice({ model: FEATURED_MODEL.id, pricing: live, defaults, dynamic: halfPrice })).toMatchObject({ input_per_m_usd: 2, output_per_m_usd: 8, fixed: true });
    });

    it("an average chat costs about $0.005 on the 7-day token mix", () => {
        const c = perChatUsd({ input: 2, output: 8 });
        expect(c).toBeGreaterThan(0.0045);
        expect(c).toBeLessThan(0.0055);
    });

    it("break-even at $0.087/h ($2.09/day): about 440 chats a day", () => {
        const n = breakEvenChatsPerDay({ price: { input: 2, output: 8 }, gpuUsdPerDay: 0.087 * 24 });
        expect(n).toBeGreaterThan(420);
        expect(n).toBeLessThan(460);
    });
});
