import { describe, expect, it } from "vitest";
import { effectivePrice, describePrice } from "../apps/web/lib/billing/operator-prices.js";
import { DEFAULT_INFERENCE_PRICING } from "../apps/web/lib/billing/core.js";
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
        expect(e).toMatchObject({ input_per_m_usd: 0.1, output_per_m_usd: 0.4, source: "house", fixed: true });
        expect(describePrice({ model: FEATURED_MODEL.id, pricing: DEFAULT_INFERENCE_PRICING, defaults, dynamic: halfPrice }).fixed).toBe(true);
        // Other house prices still follow the market.
        expect(effectivePrice({ model: "qwen2.5:7b", pricing: DEFAULT_INFERENCE_PRICING, defaults, dynamic: halfPrice }).source).toBe("dynamic");
    });

    it("an average chat costs about $0.005 on the 7-day token mix", () => {
        const c = perChatUsd({ input: 0.1, output: 0.4 });
        expect(c).toBeGreaterThan(0.0045);
        expect(c).toBeLessThan(0.0055);
    });

    it("break-even at $0.087/h ($2.09/day): about 460 chats a day", () => {
        const n = breakEvenChatsPerDay({ price: { input: 0.1, output: 0.4 }, gpuUsdPerDay: 0.087 * 24 });
        expect(n).toBeGreaterThan(400);
        expect(n).toBeLessThan(500);
    });
});
