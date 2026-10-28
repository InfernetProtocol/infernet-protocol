/**
 * Provider earnings: the pure half (no DB, no network) so the money math is
 * testable on its own. lib/data/earnings.js does the reads and writes.
 *
 * Every completed job credits the provider(s) that served it, one row per
 * (job, provider) in provider_earnings:
 *
 *   kind 'paid'     the client paid payment_offer; providers split it after
 *                   the house fee. 'pending' until the client's payment is
 *                   confirmed by the CoinPay webhook, then 'confirmed'.
 *   kind 'subsidy'  a free job (playground, payment_offer 0). The house pays
 *                   a rate per 1k output tokens. 'pending_approval' until
 *                   Anthony approves the rate, then 'confirmed'.
 *
 * Earnings accrue whether or not a payout address is set. The address is
 * only needed to withdraw:
 *
 *   available = confirmed - (requested + approved + sent payouts)
 */

export const EARNING_STATUSES = ["pending_approval", "pending", "confirmed", "void"];
export const OPEN_PAYOUT_STATUSES = ["requested", "approved", "sending"];
export const PAYOUT_STATUSES = ["requested", "approved", "sending", "sent", "rejected", "failed"];

// Conservative proposal until Anthony sets the real numbers (settings row
// key 'earnings' overrides these, and so do the env vars).
export const DEFAULT_EARNINGS_CONFIG = Object.freeze({
    // $0.50 per 1M output tokens: below what small open models retail for on
    // hosted APIs, so the house is never paying more than the work is worth.
    subsidy_per_1k_output_usd: 0.0005,
    subsidy_approved: false,
    // The published house fee: 2% of paid jobs, the operator keeps 98%.
    house_fee_pct: 2,
    min_payout_usd: 5,
    // Requests at or below this many USD are approved and sent the moment
    // they are made. 0 = every request waits for an admin.
    auto_approve_max_usd: 0
});

function num(v, fallback) {
    const n = typeof v === "string" ? Number.parseFloat(v) : v;
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(v, fallback) {
    if (v === true || v === "true" || v === "1" || v === 1) return true;
    if (v === false || v === "false" || v === "0" || v === 0) return false;
    return fallback;
}

/**
 * Resolve the live config: defaults < env < settings row. Anything malformed
 * falls back to the layer below, so a bad value can never mint money.
 */
export function resolveEarningsConfig({ env = process.env, settings = null } = {}) {
    const d = DEFAULT_EARNINGS_CONFIG;
    const fromEnv = {
        subsidy_per_1k_output_usd: num(env.INFERNET_SUBSIDY_PER_1K_OUTPUT_USD, d.subsidy_per_1k_output_usd),
        subsidy_approved: bool(env.INFERNET_SUBSIDY_APPROVED, d.subsidy_approved),
        house_fee_pct: num(env.INFERNET_HOUSE_FEE_PCT, d.house_fee_pct),
        min_payout_usd: num(env.INFERNET_MIN_PAYOUT_USD, d.min_payout_usd),
        auto_approve_max_usd: num(env.INFERNET_AUTO_APPROVE_MAX_USD, d.auto_approve_max_usd)
    };
    const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    const out = {
        subsidy_per_1k_output_usd: num(s.subsidy_per_1k_output_usd, fromEnv.subsidy_per_1k_output_usd),
        subsidy_approved: bool(s.subsidy_approved, fromEnv.subsidy_approved),
        house_fee_pct: num(s.house_fee_pct, fromEnv.house_fee_pct),
        min_payout_usd: num(s.min_payout_usd, fromEnv.min_payout_usd),
        auto_approve_max_usd: num(s.auto_approve_max_usd, fromEnv.auto_approve_max_usd)
    };
    if (out.house_fee_pct > 100) out.house_fee_pct = fromEnv.house_fee_pct <= 100 ? fromEnv.house_fee_pct : 0;
    return out;
}

/**
 * Output tokens for a finished job. The daemon reports token_count in the
 * result; RPC and older daemons only give text, so estimate ~4 chars/token.
 */
export function outputTokensFor(result) {
    const r = result && typeof result === "object" ? result : {};
    const reported = Number(r.token_count ?? r.output_tokens ?? r.usage?.completion_tokens);
    if (Number.isFinite(reported) && reported > 0) return Math.round(reported);
    const text = typeof r.text === "string" ? r.text : "";
    return text ? Math.ceil(text.length / 4) : 0;
}

/** Round to 8 decimals: stored as numeric, displayed with up to 6. */
export function roundUsd(n) {
    return Math.round((Number(n) || 0) * 1e8) / 1e8;
}

/**
 * Normalise a share list ({ provider_id, share, role }) so shares sum to 1.
 * A missing / empty list means the single serving provider gets it all.
 */
export function normaliseShares(shares, providerId) {
    const list = (Array.isArray(shares) ? shares : [])
        .filter((s) => s && s.provider_id && Number(s.share) > 0);
    if (list.length === 0) {
        return providerId ? [{ provider_id: providerId, share: 1, role: "single" }] : [];
    }
    // Same provider twice (a node that is both primary and a slice) is one row.
    const merged = new Map();
    for (const s of list) {
        const prev = merged.get(s.provider_id);
        merged.set(s.provider_id, {
            provider_id: s.provider_id,
            share: (prev?.share ?? 0) + Number(s.share),
            role: prev ? prev.role : (s.role ?? "single")
        });
    }
    const total = [...merged.values()].reduce((a, s) => a + s.share, 0);
    return [...merged.values()].map((s) => ({ ...s, share: s.share / total }));
}

/**
 * The provider_earnings rows one completed job produces.
 *
 * @param {object} p
 * @param {object} p.job       { id, provider_id, payment_offer, payment_coin, payment_status, model_name, completed_at }
 * @param {object} [p.result]  decrypted job result (for token counts)
 * @param {Array}  [p.shares]  [{ provider_id, share, role }] for multi-provider jobs
 * @param {object} p.config    resolveEarningsConfig() output
 * @param {string} [p.source]  where the credit came from, for the audit trail
 */
export function computeJobCredits({ job, result, shares, config, source = "completion" }) {
    if (!job?.id) return [];
    const parts = normaliseShares(shares, job.provider_id);
    if (parts.length === 0) return [];
    const tokens = outputTokensFor(result);
    const offer = num(job.payment_offer, 0);
    const paid = offer > 0;
    const feePct = paid ? config.house_fee_pct : 0;
    const rate = paid ? null : config.subsidy_per_1k_output_usd;
    const gross = paid ? offer : (tokens / 1000) * (rate ?? 0);
    const status = paid
        ? (job.payment_status === "confirmed" ? "confirmed" : "pending")
        : (config.subsidy_approved ? "confirmed" : "pending_approval");
    const now = new Date().toISOString();

    return parts.map((s) => {
        const shareGross = gross * s.share;
        const fee = shareGross * (feePct / 100);
        return {
            job_id: job.id,
            provider_id: s.provider_id,
            kind: paid ? "paid" : "subsidy",
            role: s.role,
            share: roundUsd(s.share),
            output_tokens: Math.round(tokens * s.share),
            rate_per_1k_usd: rate,
            gross_usd: roundUsd(shareGross),
            fee_usd: roundUsd(fee),
            amount_usd: roundUsd(shareGross - fee),
            coin: paid ? (job.payment_coin ?? "USDC") : null,
            status,
            model_name: job.model_name ?? null,
            confirmed_at: status === "confirmed" ? now : null,
            earned_at: job.completed_at ?? now,
            metadata: { source, house_fee_pct: feePct }
        };
    });
}

/**
 * Balance for one provider from its ledger rows and payout requests.
 * Amounts in USD. `available` is what a withdrawal can ask for now.
 */
export function summariseBalance(earnings = [], payouts = []) {
    const sum = (rows) => roundUsd(rows.reduce((a, r) => a + (Number(r.amount_usd) || 0), 0));
    const by = (status) => earnings.filter((e) => e.status === status);
    const confirmed = sum(by("confirmed"));
    const pendingApproval = sum(by("pending_approval"));
    const pending = sum(by("pending"));
    const open = sum(payouts.filter((p) => OPEN_PAYOUT_STATUSES.includes(p.status)));
    const paid = sum(payouts.filter((p) => p.status === "sent"));
    return {
        pending_approval_usd: pendingApproval,
        pending_usd: pending,
        confirmed_usd: confirmed,
        requested_usd: open,
        paid_usd: paid,
        available_usd: roundUsd(Math.max(0, confirmed - open - paid)),
        jobs_credited: earnings.filter((e) => e.status !== "void").length
    };
}

/** Whether a new request of this amount is sent without waiting for an admin. */
export function isAutoApprovable(amountUsd, config) {
    const cap = Number(config?.auto_approve_max_usd) || 0;
    const amount = Number(amountUsd);
    return cap > 0 && Number.isFinite(amount) && amount > 0 && amount <= cap + 1e-9;
}

/** Validate a withdrawal request against the balance and config. */
export function checkPayoutRequest({ balance, amountUsd, config, hasAddress, hasOpenRequest }) {
    if (!hasAddress) {
        return { ok: false, error: "set a payout address first: infernet payout set <coin> <address>" };
    }
    if (hasOpenRequest) return { ok: false, error: "a payout request is already waiting for approval" };
    const available = Number(balance?.available_usd) || 0;
    const amount = amountUsd == null ? available : Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: available > 0 ? "amount must be a positive number" : "nothing confirmed to withdraw yet" };
    }
    if (amount > available + 1e-9) {
        return { ok: false, error: `amount $${fmtAmount(amount)} is more than the available $${fmtAmount(available)}` };
    }
    if (amount < config.min_payout_usd) {
        return { ok: false, error: `minimum payout is $${fmtAmount(config.min_payout_usd)} (available $${fmtAmount(available)})` };
    }
    return { ok: true, amount: roundUsd(amount) };
}

/**
 * "$0.00" hides sub-cent credits, which is exactly what made a provider
 * think he had earned nothing. Show up to 6 decimals below a cent.
 */
export function fmtAmount(n) {
    const v = Number(n) || 0;
    if (v === 0) return "0.00";
    if (Math.abs(v) >= 0.01) return v.toFixed(2);
    return v.toFixed(6).replace(/0+$/, "");
}

export function fmtUsdPrecise(n) {
    return `$${fmtAmount(n)}`;
}

export const EARNING_STATUS_LABELS = {
    pending_approval: "pending approval",
    pending: "awaiting client payment",
    confirmed: "confirmed",
    void: "void"
};
