/**
 * Order pricing from our cost (docs/prd/16-managed-endpoints.md, "Self-serve
 * orders"). For nodes rented through us we know the cost per hour, so the
 * self-serve price is that cost marked up by a minimum profit margin:
 *
 *   price_per_hour = cost_per_hour * (1 + min_margin_pct / 100), rounded up to the cent
 *
 * The margin is a house knob (settings row key 'orders', admin slider at
 * /admin/pricing), 1% to 2000%, default 100% (twice our cost). The setup fee
 * stays $5 + one hour at that price.
 *
 * Nothing here touches the database or the network.
 */
export const MIN_MARGIN_PCT = 1;
export const MAX_MARGIN_PCT = 2000;
export const DEFAULT_MARGIN_PCT = 100;

function pct(v) {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= MIN_MARGIN_PCT && n <= MAX_MARGIN_PCT ? n : null;
}

/** True when v is an allowed margin (1..2000). */
export function isValidMargin(v) {
    return pct(v) !== null;
}

/**
 * Resolve the live margin: default < env INFERNET_ORDER_MARGIN_PCT < settings
 * row. Anything out of range falls back to the layer below.
 */
export function resolveOrderPricing({ env = process.env, settings = null } = {}) {
    const fromEnv = pct(env?.INFERNET_ORDER_MARGIN_PCT) ?? DEFAULT_MARGIN_PCT;
    const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    return { min_margin_pct: pct(s.min_margin_pct) ?? fromEnv };
}

/** Hourly price for a cost at a margin, rounded up so it never dips under the margin. */
export function priceFromCost(cost, marginPct = DEFAULT_MARGIN_PCT) {
    const m = pct(marginPct) ?? DEFAULT_MARGIN_PCT;
    // Round away float noise first (0.99 * 2 = 1.9800000000000002), then up to the cent.
    const raw = Math.round(Number(cost) * (1 + m / 100) * 1e6) / 1e6;
    return Math.ceil(raw * 100) / 100;
}
