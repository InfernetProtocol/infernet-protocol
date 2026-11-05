import { NextResponse } from "next/server";
import { getInferencePricing } from "@/lib/data/billing";
import { getPriceDefaults, marketPriceFor } from "@/lib/data/operator-prices";
import { describePrice } from "@/lib/billing/operator-prices";
import { liveModelNames } from "@/lib/data/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/pricing            every live model and what it costs right now
 * GET /api/v1/pricing?model=<id> one model
 *
 * Public and unauthenticated on purpose. The default price moves with supply
 * and demand, so a buyer has to be able to see the current number before they
 * spend a balance on it — a market whose price you can only discover by being
 * charged is not one anybody should trust. Each row carries the market inputs
 * it was derived from (nodes serving it, capacity, how much is busy, the
 * multiplier and why), so the price is explainable rather than asserted.
 *
 * An operator's own price is per node, so it is not shown here: this is the
 * network price for a model nobody has overridden. `infernet price list`
 * shows an operator their own.
 */
export async function GET(request) {
    const wanted = new URL(request.url).searchParams.get("model");
    try {
        const [pricing, defaults, live] = await Promise.all([
            getInferencePricing(),
            getPriceDefaults(),
            liveModelNames().catch(() => [])
        ]);

        const models = wanted ? [wanted] : [...new Set([...live, ...Object.keys(pricing.models ?? {})])].sort();
        const rows = await Promise.all(
            models.map(async (model) => {
                const market = await marketPriceFor({ model, defaults });
                const d = describePrice({ model, pricing, defaults, dynamic: market });
                return {
                    model,
                    input_per_m_usd: d.input_per_m_usd,
                    output_per_m_usd: d.output_per_m_usd,
                    per_1k_output_usd: d.per_1k_output_usd,
                    source: d.source,
                    ...(d.dynamic ? { market: d.dynamic } : {}),
                    live: live.includes(model)
                };
            })
        );

        return NextResponse.json(
            {
                currency: "USD",
                unit: "per 1M tokens",
                note: "A model nobody has priced follows supply and demand; an operator or the house can override it. Prices are bounded either way.",
                default_model_price: defaults.default_model_price,
                bounds: {
                    min_per_m_usd: defaults.operator_price_min_per_m_usd,
                    max_per_m_usd: defaults.operator_price_max_per_m_usd
                },
                models: rows
            },
            { headers: { "cache-control": "public, max-age=30" } }
        );
    } catch (err) {
        console.error("[pricing]", err?.message ?? err);
        return NextResponse.json({ error: "pricing unavailable" }, { status: 503 });
    }
}
