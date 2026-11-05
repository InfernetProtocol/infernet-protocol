import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
    resolvePriceDefaults,
    checkOperatorPrice,
    effectivePrice,
    describePrice,
    cleanPricePair
} from "@/lib/billing/operator-prices";

/**
 * Operator model prices (DB half). The layering and the bounds are in
 * lib/billing/operator-prices.js.
 *
 * An operator prices the models their own node serves; the house sets the
 * default for anything nobody has priced, and the band those operator prices
 * must sit in.
 */

function db(supabase) {
    return supabase ?? getSupabaseServerClient();
}

function withStatus(message, status, extra = {}) {
    return Object.assign(new Error(message), { status, ...extra });
}

/** The default + bounds, read off the same `inference_pricing` settings row. */
export async function getPriceDefaults(supabase) {
    let settings = null;
    try {
        const { data } = await db(supabase).from("settings").select("value").eq("key", "inference_pricing").maybeSingle();
        settings = data?.value ?? null;
    } catch {
        /* defaults + env */
    }
    return resolvePriceDefaults({ env: process.env, settings });
}

/** One node's prices, as a {model: {input_per_m_usd, output_per_m_usd}} map. */
export async function getProviderPrices(providerId, supabase) {
    if (!providerId) return {};
    const { data, error } = await db(supabase)
        .from("provider_model_prices")
        .select("model, input_per_m_usd, output_per_m_usd, updated_at")
        .eq("provider_id", providerId);
    if (error) {
        // Never fatal: a price lookup that fails falls back to the house
        // price, which is the safe direction (it is never free).
        console.warn(`[operator-prices] read failed for ${providerId}: ${error.message}`);
        return {};
    }
    const out = {};
    for (const row of data ?? []) {
        const pair = cleanPricePair({
            input_per_m_usd: Number(row.input_per_m_usd),
            output_per_m_usd: Number(row.output_per_m_usd)
        });
        if (pair) out[row.model] = { ...pair, updated_at: row.updated_at };
    }
    return out;
}

/** The price one node charges for one model, or null. */
export async function getProviderPrice(providerId, model, supabase) {
    if (!providerId || !model) return null;
    const { data, error } = await db(supabase)
        .from("provider_model_prices")
        .select("input_per_m_usd, output_per_m_usd")
        .eq("provider_id", providerId)
        .eq("model", model)
        .maybeSingle();
    if (error || !data) return null;
    return cleanPricePair({
        input_per_m_usd: Number(data.input_per_m_usd),
        output_per_m_usd: Number(data.output_per_m_usd)
    });
}

/**
 * The price a finished job is charged at: the serving node's own price if it
 * has one, else the house table, else the default. Never throws and never
 * returns "free" - the default is the floor of the system.
 */
export async function priceForJob({ providerId, model, pricing, supabase }) {
    const defaults = await getPriceDefaults(supabase);
    let operatorPrice = null;
    if (defaults.operator_pricing_enabled && providerId && model) {
        try {
            operatorPrice = await getProviderPrice(providerId, model, supabase);
        } catch {
            /* house price */
        }
    }
    // The market scales whichever base applies - the house rate card or the
    // house default - so the snapshot is worth reading whenever the operator
    // has not set their own price. An operator price is never scaled.
    let dynamic = null;
    if (!operatorPrice && model) {
        dynamic = await marketPriceFor({ model, defaults, supabase });
    }
    return effectivePrice({ model, pricing, defaults, operatorPrice, dynamic });
}

/**
 * The dynamic default for one model: read the live fleet serving it, turn that
 * into a multiplier, and scale the base.
 *
 * Cached for a short window so a burst of requests sees one price rather than
 * a slightly different one each time, and so pricing never becomes the reason
 * the database is busy. Never throws: no snapshot means the plain base.
 */
const marketCache = new Map(); // model -> { at, value }
const MARKET_TTL_MS = 30_000;

export async function marketPriceFor({ model, defaults, supabase, now = Date.now() }) {
    const hit = marketCache.get(model);
    if (hit && now - hit.at < MARKET_TTL_MS) return hit.value;

    try {
        const { getDynamicConfig, marketSnapshot } = await import("@/lib/data/dynamic-pricing");
        const { scaleByMarket } = await import("@/lib/billing/dynamic-price");

        const config = await getDynamicConfig(supabase);
        if (!config.dynamic_pricing_enabled) {
            marketCache.set(model, { at: now, value: null });
            return null;
        }
        const signal = await marketSnapshot({ model, supabase });
        // A scaler, not a price: the caller supplies the base (the model's
        // house rate card, or the default), so per-model differences survive.
        const value = { scale: scaleByMarket({ signal, config, bounds: defaults }), signal, config };
        marketCache.set(model, { at: now, value });
        return value;
    } catch (err) {
        console.warn(`[operator-prices] market snapshot failed for ${model}: ${err?.message ?? err}`);
        marketCache.set(model, { at: now, value: null });
        return null;
    }
}

/** Test hook: drop the market cache. */
export function clearMarketCache() {
    marketCache.clear();
}

/** Set one model's price on a node the caller owns. Refused outside the band. */
export async function setProviderPrice({ providerId, model, price, actor }) {
    const defaults = await getPriceDefaults();
    const check = checkOperatorPrice(price, defaults);
    if (!check.ok) throw withStatus(check.error, 400, check.bounds ? { bounds: check.bounds } : {});
    if (typeof model !== "string" || !model || model.length > 200) {
        throw withStatus("model is required", 400);
    }

    const { error } = await db()
        .from("provider_model_prices")
        .upsert(
            {
                provider_id: providerId,
                model,
                input_per_m_usd: check.value.input_per_m_usd,
                output_per_m_usd: check.value.output_per_m_usd,
                set_by: actor ?? null,
                updated_at: new Date().toISOString()
            },
            { onConflict: "provider_id,model" }
        );
    if (error) throw withStatus(error.message, 500);
    return { model, ...check.value, bounds: { min: defaults.operator_price_min_per_m_usd, max: defaults.operator_price_max_per_m_usd } };
}

/** Drop a node's override, so the model falls back to the house price. */
export async function clearProviderPrice({ providerId, model }) {
    const { error } = await db()
        .from("provider_model_prices")
        .delete()
        .eq("provider_id", providerId)
        .eq("model", model);
    if (error) throw withStatus(error.message, 500);
    return { model, cleared: true };
}

/**
 * Everything a node's owner needs to see: one row per model the node serves
 * (plus any it has priced but no longer serves), showing the effective price
 * and which layer set it.
 */
export async function listProviderPricing({ providerId, servedModels = [] }) {
    const supabase = db();
    const { getInferencePricing } = await import("@/lib/data/billing");
    const [pricing, defaults, mine] = await Promise.all([
        getInferencePricing(supabase),
        getPriceDefaults(supabase),
        getProviderPrices(providerId, supabase)
    ]);

    const models = [...new Set([...(servedModels ?? []).filter(Boolean), ...Object.keys(mine)])].sort();
    return {
        provider_id: providerId,
        operator_pricing_enabled: defaults.operator_pricing_enabled,
        bounds: {
            min_per_m_usd: defaults.operator_price_min_per_m_usd,
            max_per_m_usd: defaults.operator_price_max_per_m_usd
        },
        default_model_price: defaults.default_model_price,
        models: await Promise.all(
            models.map(async (model) => {
                const dynamic = mine[model] ? null : await marketPriceFor({ model, defaults, supabase });
                return describePrice({ model, pricing, defaults, operatorPrice: mine[model] ?? null, dynamic });
            })
        )
    };
}
