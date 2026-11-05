/**
 * Pay-as-you-go for interactive inference: the pure half.
 *
 * Paid batch inference (lib/billing/core.js) already prices per model in
 * integer micro-USD, holds funds at submit and charges per item at settle.
 * Interactive requests cannot work that way — nobody waits for a quote to
 * send a chat message — so they are priced on exactly the same table and
 * charged once, after the fact:
 *
 *   authorise   is this caller identified, and does the balance have anything
 *               in it (counting what their nodes earned)?
 *   run         the request goes out as it always did
 *   charge      one ledger entry, idem key job:<id>:charge
 *
 * The risk a hold would remove is that a request costs more than the balance
 * had. That is bounded by max_tokens and settled by capping the charge at the
 * balance (billing_charge_interactive), so the worst case is a fraction of a
 * cent the house absorbs, not a consumer in debt.
 */

import {
    MICRO,
    modelPriceMicro,
    estimateInputTokens,
    estimateOutputTokens,
    costMicro,
    microToUsd
} from "./core.js";

/** Settings row that switches interactive metering on and shapes the free tier. */
export const INTERACTIVE_SETTINGS_KEY = "interactive_billing";

/**
 * The house's cut of an interactive charge, in percent. The provider keeps the
 * rest, exactly as on a paid batch.
 *
 * 20% (Anthony, 2026-11-05: "no 20% margin" - 20, not the 100 I had proposed).
 * It is a fee on the charge rather than a markup over a cost basis because
 * that is how this ledger already pays providers: the customer price is the
 * per-model table, and provider_earnings takes its share of what was actually
 * collected. A markup on the free-tier subsidy rate instead would pay a
 * provider many times the sale price on these models.
 */
export const DEFAULT_INTERACTIVE_HOUSE_FEE_PCT = 20;

export const DEFAULT_INTERACTIVE_CONFIG = Object.freeze({
    house_fee_pct: DEFAULT_INTERACTIVE_HOUSE_FEE_PCT,
    /**
     * Off by default so deploying this charges nobody until it is switched on
     * deliberately, per environment.
     */
    enabled: false,
    /**
     * An identified caller with an empty balance falls back to the free,
     * IP-rate-limited tier rather than getting a 402. The free tier is the
     * product's front door; metering must not shut it.
     */
    free_tier_when_empty: true,
    /**
     * Pull from confirmed node earnings to cover a charge the prepaid balance
     * cannot. This is "use what you earned to pay for tasks": on by default,
     * since a provider who has earned money should not have to top up to use
     * the network.
     */
    spend_earned: true,
    /**
     * A model with no price in the table is served free rather than refused.
     * Refusing would make adding a model to the network a billing incident.
     */
    free_when_unpriced: true
});

function pct(v, fallback) {
    const n = typeof v === "string" ? Number.parseFloat(v) : v;
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

function bool(v, fallback) {
    if (v === true || v === "true" || v === "1" || v === 1) return true;
    if (v === false || v === "false" || v === "0" || v === 0) return false;
    return fallback;
}

/** defaults < env < settings row, same contract as the rest of billing config. */
export function resolveInteractiveConfig({ env = {}, settings = null } = {}) {
    const d = DEFAULT_INTERACTIVE_CONFIG;
    const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    const fromEnv = {
        house_fee_pct: pct(env.INFERNET_INTERACTIVE_HOUSE_FEE_PCT, d.house_fee_pct),
        enabled: bool(env.INFERNET_INTERACTIVE_BILLING, d.enabled),
        free_tier_when_empty: bool(env.INFERNET_INTERACTIVE_FREE_TIER, d.free_tier_when_empty),
        spend_earned: bool(env.INFERNET_INTERACTIVE_SPEND_EARNED, d.spend_earned),
        free_when_unpriced: bool(env.INFERNET_INTERACTIVE_FREE_UNPRICED, d.free_when_unpriced)
    };
    return {
        house_fee_pct: pct(s.house_fee_pct, fromEnv.house_fee_pct),
        enabled: bool(s.enabled, fromEnv.enabled),
        free_tier_when_empty: bool(s.free_tier_when_empty, fromEnv.free_tier_when_empty),
        spend_earned: bool(s.spend_earned, fromEnv.spend_earned),
        free_when_unpriced: bool(s.free_when_unpriced, fromEnv.free_when_unpriced)
    };
}

/**
 * Everything a caller can spend right now: topped-up balance not held by a
 * batch, plus what their nodes have earned and not withdrawn.
 */
export function spendableMicro({ funding, config }) {
    const prepaid = Math.max(0, Number(funding?.prepaid_available_micro) || 0);
    const earned = config?.spend_earned ? Math.max(0, Number(funding?.earned_spendable_micro) || 0) : 0;
    return prepaid + earned;
}

/**
 * How this request is paid for, decided before it runs.
 *
 *   free         metering off, anonymous caller, unpriced model, or an empty
 *                balance while the free tier is on → the existing IP-limited path
 *   balance      charge it when it finishes
 *   insufficient empty balance with the free tier switched off → 402
 */
export function interactiveModeFor({ model, pricing, config, funding, defaults = null, signedIn = true }) {
    if (!config?.enabled) return { mode: "free", reason: "metering_off" };
    if (!signedIn) return { mode: "free", reason: "anonymous" };
    if (pricing?.enabled === false) return { mode: "free", reason: "pricing_disabled" };

    // Pre-flight does not know which node will serve this yet, so it cannot
    // apply an operator price. It only needs to know a price EXISTS, and with
    // a house default one always does: `defaults` is passed once operator
    // pricing is live, and `free_when_unpriced` is the pre-default behaviour
    // kept for a network that has deliberately cleared its default.
    const price = modelPriceMicro(pricing, model) ?? (defaults?.default_model_price ? { default: true } : null);
    if (!price) {
        return config.free_when_unpriced
            ? { mode: "free", reason: "unpriced_model" }
            : { mode: "insufficient", reason: "unpriced_model" };
    }

    const spendable = spendableMicro({ funding, config });
    if (spendable > 0) return { mode: "balance", reason: "balance", spendable_micro: spendable, price };
    return config.free_tier_when_empty
        ? { mode: "free", reason: "empty_balance" }
        : { mode: "insufficient", reason: "empty_balance", spendable_micro: 0 };
}

/**
 * Price one finished interactive request, on the same table and the same
 * server-side token estimate paid batches use. The provider's own token count
 * is deliberately ignored: a node must not be able to inflate a bill.
 */
export function priceInteractive({ model, pricing, price = null, messages, inputTokens = null, result, maxTokens = null }) {
    // `price` is the resolved operator/house/default price for the node that
    // served this job (lib/billing/operator-prices.js). Falling back to the
    // house table alone is for callers that have no provider in hand.
    const resolved = price ?? modelPriceMicro(pricing, model);
    if (!resolved) return { priced: false, cost_micro: 0, input_tokens: 0, output_tokens: 0 };
    const input = inputTokens == null ? estimateInputTokens(messages) : Math.max(0, Math.floor(inputTokens));
    const output = estimateOutputTokens(result, Number.isInteger(maxTokens) ? maxTokens : null);
    return {
        priced: true,
        input_tokens: input,
        output_tokens: output,
        cost_micro: costMicro({
            inputTokens: input,
            outputTokens: output,
            input_micro_per_m: resolved.input_micro_per_m,
            output_micro_per_m: resolved.output_micro_per_m
        }),
        input_micro_per_m: resolved.input_micro_per_m,
        output_micro_per_m: resolved.output_micro_per_m,
        price: resolved.source ? resolved : null
    };
}

/** The ledger key for a job's charge. One per job, which is what makes it idempotent. */
export function chargeIdemKey(jobId) {
    return `job:${jobId}:charge`;
}

/** Micro-USD as a short display string: "$0.000123", "$1.20". */
export function fmtMicro(micro) {
    const n = Math.max(0, Number(micro) || 0);
    if (n === 0) return "$0.00";
    if (n >= 10_000) return `$${(n / MICRO).toFixed(2)}`;
    return `$${microToUsd(n).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}
