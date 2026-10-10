/**
 * Managed-endpoint price list (docs/prd/16-managed-endpoints.md, "Pricing").
 *
 * Infernet owns no GPUs, so the cost of a reservation is the dedicated GPU it
 * pins: rented on-demand, or paid to the named operator at about the same
 * rate. Prices are set so every billed hour clears a 20% margin:
 *
 *   price = cost / (1 - margin - payment_fee) * (1 + compliance_buffer)
 *
 * margin 20% of price, payment fee ~1%, and a 5% buffer because the buyer
 * only pays for compliant hours (at 95% uptime the cost per billed hour rises
 * ~5%). Platform overhead (dev2 share, domain, fallback) is under 1¢/hour.
 * Costs are RunPod on-demand, Sep 2026; recheck before quoting.
 *
 * Every booking also carries a setup fee: a flat $5 plus one hour at the list
 * price, because the GPU has to be warm before the first reserved hour.
 */

export const MARGIN = 0.2;
export const PAYMENT_FEE = 0.01;
export const COMPLIANCE_BUFFER = 0.05;
export const SETUP_FEE_BASE = 5;

export const GPU_TIERS = Object.freeze({
    l40s: { label: "L40S 48GB", fits: "8B-32B models", cost_per_hour: 0.99, price_per_hour: 1.35 },
    a100: { label: "A100 80GB", fits: "up to 70B quantized", cost_per_hour: 1.39, price_per_hour: 1.89 },
    h100: { label: "H100 80GB", fits: "70B quantized, fast", cost_per_hour: 2.99, price_per_hour: 3.99 },
    "h100x2": { label: "2x H100 80GB", fits: "70B full precision or long context", cost_per_hour: 5.98, price_per_hour: 7.99 }
});

/** Lowest hourly price that still makes the margin on this cost. */
export function floorPrice(cost) {
    return Math.ceil((cost / (1 - MARGIN - PAYMENT_FEE)) * (1 + COMPLIANCE_BUFFER) * 100) / 100;
}

export function tierOf(gpuClass) {
    if (typeof gpuClass !== "string") return null;
    return GPU_TIERS[gpuClass.trim().toLowerCase()] ?? null;
}

export function setupFeeFor(pricePerHour) {
    return Math.round((SETUP_FEE_BASE + Number(pricePerHour)) * 100) / 100;
}

/** The public price list, as served by GET /api/v1/reservations/pricing. */
export function priceList() {
    return {
        currency: "USD",
        basis: "per compliant hour, post-paid; non-compliant hours are owed nothing",
        setup_fee: `$${SETUP_FEE_BASE} + one hour at the tier price, once per booking (GPU warm-up)`,
        tiers: Object.entries(GPU_TIERS).map(([gpu_class, t]) => ({
            gpu_class,
            label: t.label,
            fits: t.fits,
            price_per_hour: t.price_per_hour,
            setup_fee: setupFeeFor(t.price_per_hour)
        }))
    };
}
