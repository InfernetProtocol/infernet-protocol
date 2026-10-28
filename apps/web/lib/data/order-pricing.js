import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { resolveOrderPricing, isValidMargin, MIN_MARGIN_PCT, MAX_MARGIN_PCT } from "@/lib/reservations/margin";
import { ALL_TIERS } from "@/lib/reservations/pricing";
import { quoteFor } from "@/lib/reservations/orders";

/** Self-serve order pricing knob (settings row key 'orders'). Math in lib/reservations/margin.js. */

const SETTINGS_KEY = "orders";

function db(supabase) {
    return supabase ?? getSupabaseServerClient();
}

export async function getOrderPricing(supabase) {
    let settings = null;
    try {
        const { data } = await db(supabase).from("settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
        settings = data?.value ?? null;
    } catch {
        /* default + env */
    }
    return resolveOrderPricing({ settings });
}

/** The margin plus what every class sells for at it, for the admin page and API. */
export function pricingView(config) {
    return {
        ...config,
        range: { min: MIN_MARGIN_PCT, max: MAX_MARGIN_PCT },
        classes: Object.entries(ALL_TIERS).map(([gpu_class, t]) => {
            const q = quoteFor(gpu_class, 1, config.min_margin_pct);
            return { gpu_class, label: t.label, cost_per_hour: t.cost_per_hour, price_per_hour: q.price_per_hour, setup_fee: q.setup_fee };
        })
    };
}

export async function updateOrderPricing(patch, { actor } = {}) {
    if (!isValidMargin(patch?.min_margin_pct)) {
        throw Object.assign(new Error(`min_margin_pct must be a number from ${MIN_MARGIN_PCT} to ${MAX_MARGIN_PCT}`), { status: 400 });
    }
    const next = resolveOrderPricing({ settings: { min_margin_pct: Number(patch.min_margin_pct) } });
    const { error } = await db()
        .from("settings")
        .upsert({ key: SETTINGS_KEY, value: { ...next, updated_by: actor ?? null }, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return next;
}
