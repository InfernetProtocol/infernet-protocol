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
 *                   Anthony approves the rate, then 'confirmed'. The token
 *                   count is the provider's, so it is clamped to the job's
 *                   max_tokens, and outliers wait for an admin.
 *   kind 'spent_on_compute'  the operator spent confirmed earnings on paid
 *                   batch inference: a negative confirmed row (and a positive
 *                   one when unused funds come back), so `available` below
 *                   already nets it out. Written only by the SQL functions in
 *                   20261102020000_paid_batch_inference.sql, which share the
 *                   provider row lock with a payout_requests trigger.
 *   kind 'reservation'  a node reservation order the buyer prepaid: one row
 *                   per reservation (no job), the hours less the house fee.
 *                   Always 'pending_approval' until an admin confirms it.
 *                   Jobs served for a reservation earn no subsidy on top.
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

// No credited job is ever worth more than this many output tokens, whatever
// the daemon reports: the subsidy is paid on the provider's own count.
export const MAX_CREDITED_OUTPUT_TOKENS = 32768;
// A subsidy credit this many times the provider's median credit is held for
// an admin instead of being confirmed (lib/data/earnings.js).
export const OUTLIER_MEDIAN_FACTOR = 3;
// Fewer credits than this and the median says nothing yet.
export const OUTLIER_MIN_HISTORY = 5;
// A credit at or below this many output tokens is never held as an outlier,
// whatever the median. A node whose history is mostly tiny health-check
// prompts (median 10-16 tokens) otherwise held every real answer above ~48
// tokens, a $0.0005 credit included (2026-11-02: 93 of ~210 credits held).
// 2048 tokens is $0.02 at the $0.01/1k subsidy: not worth an admin's review.
export const OUTLIER_FLOOR_TOKENS = 2048;

/**
 * Output tokens for a finished job, and how the number was arrived at.
 * The daemon reports token_count in the result; RPC and older daemons only
 * give text, so estimate ~4 chars/token. Either way the provider is the one
 * saying it, so the count is clamped to the job's max_tokens (or the hard
 * ceiling when the job set none).
 *
 * @returns {{ tokens: number, estimated: boolean, reported: number, clamped: boolean }}
 */
export function outputTokenCount(result, { maxTokens } = {}) {
    const r = result && typeof result === "object" ? result : {};
    const n = Number(r.token_count ?? r.output_tokens ?? r.usage?.completion_tokens);
    let reported = 0;
    let estimated = false;
    if (Number.isFinite(n) && n > 0) {
        reported = Math.round(n);
    } else {
        const text = typeof r.text === "string" ? r.text : "";
        reported = text ? Math.ceil(text.length / 4) : 0;
        estimated = reported > 0;
    }
    const max = Number(maxTokens);
    const cap = Number.isFinite(max) && max > 0
        ? Math.min(Math.floor(max), MAX_CREDITED_OUTPUT_TOKENS)
        : MAX_CREDITED_OUTPUT_TOKENS;
    const tokens = Math.min(reported, cap);
    return { tokens, estimated, reported, clamped: tokens < reported };
}

/** Output tokens for a finished job (clamped; see outputTokenCount). */
export function outputTokensFor(result, opts) {
    return outputTokenCount(result, opts).tokens;
}

export function median(values) {
    const v = (values ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Why a subsidy credit of `tokens` should wait for an admin, or null.
 * `history` is that provider's other subsidy credits (output_tokens).
 */
export function outlierReason(tokens, history, { factor = OUTLIER_MEDIAN_FACTOR, ceiling = MAX_CREDITED_OUTPUT_TOKENS, minHistory = OUTLIER_MIN_HISTORY, floor = OUTLIER_FLOOR_TOKENS } = {}) {
    const t = Number(tokens) || 0;
    if (t > ceiling) return `output_tokens ${t} above the ${ceiling} ceiling`;
    if (t <= floor) return null;
    const list = (history ?? []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
    if (list.length < minHistory) return null;
    const m = median(list);
    if (m && t > factor * m) return `output_tokens ${t} > ${factor}x provider median ${m}`;
    return null;
}

/**
 * Split pending subsidy credits into the ones an approval may confirm and
 * the outliers it must leave pending for review. Each row's median is over
 * the same provider's rows in the batch plus `history[provider_id]`.
 *
 * @param {Array<{id, provider_id, output_tokens, held_reason?}>} rows
 * @param {Record<string, number[]>} [history]
 */
export function splitSubsidyOutliers(rows, history = {}, opts = {}) {
    const byProvider = new Map();
    for (const r of rows ?? []) {
        const list = byProvider.get(r.provider_id) ?? [];
        list.push(Number(r.output_tokens) || 0);
        byProvider.set(r.provider_id, list);
    }
    const confirm = [];
    const hold = [];
    for (const r of rows ?? []) {
        if (r.held_reason) { hold.push({ id: r.id, reason: r.held_reason }); continue; }
        const sample = [...(byProvider.get(r.provider_id) ?? []), ...(history[r.provider_id] ?? [])];
        const reason = outlierReason(r.output_tokens, sample, opts);
        if (reason) hold.push({ id: r.id, reason });
        else confirm.push(r.id);
    }
    return { confirm, hold };
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
 *
 * job.max_tokens (from its input_spec) clamps the provider's reported count.
 * A free job served for a reservation (job.reservation_id) earns no subsidy:
 * the operator is paid from the reservation itself (computeReservationCredit).
 */
export function computeJobCredits({ job, result, shares, config, source = "completion" }) {
    if (!job?.id) return [];
    const parts = normaliseShares(shares, job.provider_id);
    if (parts.length === 0) return [];
    const count = outputTokenCount(result, { maxTokens: job.max_tokens });
    const tokens = count.tokens;
    // A prepaid batch item is settled by lib/data/batches.js (kind 'paid',
    // confirmed, from the customer's charge): never a subsidy on top.
    if (job.batch_item_id || job.billing === "prepaid_batch") return [];
    const offer = num(job.payment_offer, 0);
    const paid = offer > 0;
    if (!paid && job.reservation_id) return [];
    // The subsidy is off (rate 0): write nothing rather than a row worth
    // $0.00. The network served 5,311 subsidised jobs before the rate was
    // stopped on 2026-11-05, so leaving this on would accumulate thousands of
    // zero-value rows that every balance query then has to read past, and
    // would tell an operator they "earned" nothing on a job instead of being
    // honest that free traffic is not paid for.
    if (!paid && !(num(config.subsidy_per_1k_output_usd, 0) > 0)) return [];
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
            tokens_estimated: count.estimated,
            held_reason: null,
            rate_per_1k_usd: rate,
            gross_usd: roundUsd(shareGross),
            fee_usd: roundUsd(fee),
            amount_usd: roundUsd(shareGross - fee),
            coin: paid ? (job.payment_coin ?? "USDC") : null,
            status,
            model_name: job.model_name ?? null,
            confirmed_at: status === "confirmed" ? now : null,
            earned_at: job.completed_at ?? now,
            metadata: {
                source,
                house_fee_pct: feePct,
                ...(count.clamped ? { reported_tokens: count.reported, clamped_to: tokens } : {})
            }
        };
    });
}

/**
 * Hold outlier subsidy credits for review: a credit far above its provider's
 * median stays 'pending_approval' (with held_reason) even when the subsidy is
 * approved. `history` maps provider_id to that provider's recent subsidy
 * output_tokens. Paid credits are left alone: the client paid that amount.
 */
export function applyOutlierHolds(rows, history = {}, opts = {}) {
    return (rows ?? []).map((r) => {
        if (r.kind !== "subsidy") return r;
        const reason = outlierReason(r.output_tokens, history[r.provider_id] ?? [], opts);
        if (!reason) return r;
        return { ...r, status: "pending_approval", confirmed_at: null, held_reason: reason };
    });
}

/**
 * The one provider_earnings row a fulfilled node reservation order produces:
 * the hours the buyer prepaid (total less the setup fee, which covers our
 * warm-up and stays with the house) less the house fee. Always
 * 'pending_approval': an admin confirms it once the hours were delivered, so
 * it is never withdrawable on its own. Rented-GPU orders (no provider) earn none.
 *
 * @param {object} p
 * @param {object} p.order          reservation_orders row (fulfilled)
 * @param {string} p.reservationId  the reservation it created
 * @param {object} p.config         resolveEarningsConfig() output
 */
export function computeReservationCredit({ order, reservationId, config }) {
    if (!order?.provider_id || !reservationId) return null;
    const total = num(order.total_usd, 0);
    const setup = Math.min(num(order.setup_fee, 0), total);
    const gross = total - setup;
    if (!(gross > 0)) return null;
    const feePct = num(config?.house_fee_pct, DEFAULT_EARNINGS_CONFIG.house_fee_pct);
    const fee = gross * (Math.min(feePct, 100) / 100);
    return {
        job_id: null,
        reservation_id: reservationId,
        provider_id: order.provider_id,
        kind: "reservation",
        role: "single",
        share: 1,
        output_tokens: 0,
        tokens_estimated: false,
        rate_per_1k_usd: null,
        gross_usd: roundUsd(gross),
        fee_usd: roundUsd(fee),
        amount_usd: roundUsd(gross - fee),
        coin: null,
        status: "pending_approval",
        model_name: Array.isArray(order.models) ? (order.models[0] ?? null) : null,
        confirmed_at: null,
        earned_at: order.paid_at ?? new Date().toISOString(),
        metadata: {
            source: "reservation_order",
            order_id: order.id ?? null,
            house_fee_pct: feePct,
            total_usd: total,
            setup_fee: setup,
            hours: order.hours ?? null
        }
    };
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
        // Earnings moved to (or back from) the compute balance are not jobs.
        spent_on_compute_usd: roundUsd(-sum(earnings.filter((e) => e.kind === "spent_on_compute" && e.status === "confirmed"))),
        jobs_credited: earnings.filter((e) => e.status !== "void" && e.kind !== "spent_on_compute").length
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
/**
 * Network-wide money totals across every node, for the public /status page.
 *   earned  every non-void credit (paid jobs, subsidy, reservations), split
 *           into confirmed and not-yet-confirmed (pending / pending_approval)
 *   spent   net confirmed earnings nodes moved into paid batch inference
 *           (spent_on_compute debits less returns), plus payouts sent out
 */
export function summariseNetworkMoney(earnings = [], payouts = []) {
    const sum = (rows) => roundUsd(rows.reduce((a, r) => a + (Number(r.amount_usd) || 0), 0));
    const credits = earnings.filter((e) => e.status !== "void" && e.kind !== "spent_on_compute");
    const confirmed = sum(credits.filter((e) => e.status === "confirmed"));
    const pending = sum(credits.filter((e) => e.status !== "confirmed"));
    const spentOnCompute = roundUsd(Math.max(0,
        -sum(earnings.filter((e) => e.kind === "spent_on_compute" && e.status === "confirmed"))));
    const paidOut = sum(payouts.filter((p) => p.status === "sent"));
    const earners = new Set(credits.map((e) => e.provider_id).filter(Boolean));
    return {
        earned_usd: roundUsd(confirmed + pending),
        earned_confirmed_usd: confirmed,
        earned_pending_usd: pending,
        spent_usd: roundUsd(spentOnCompute + paidOut),
        spent_on_compute_usd: spentOnCompute,
        paid_out_usd: paidOut,
        earning_nodes: earners.size,
        credits: credits.length,
        ...summariseFees(credits)
    };
}

/**
 * What the platform itself has earned, and what it paid to get there.
 *
 * Every earning row splits the customer's charge: the provider keeps
 * amount_usd, the house keeps fee_usd, and the two sum to gross_usd. So the
 * platform's revenue is just the sum of fee_usd, with no second ledger to
 * reconcile against.
 *
 * Only CONFIRMED rows count. A pending fee is not money the house has. And a
 * subsidised job carries fee_usd 0 by definition: there the house is paying
 * for the traffic rather than taking a cut of it, which is why `subsidised_usd`
 * is reported next to the fee. Showing fees without it would read as profit.
 */
export function summariseFees(credits = []) {
    const confirmed = credits.filter((e) => e.status === "confirmed");
    const fee = (r) => Number(r.fee_usd) || 0;
    const feeBearing = confirmed.filter((r) => fee(r) > 0);
    return {
        fees_usd: roundUsd(confirmed.reduce((a, r) => a + fee(r), 0)),
        fee_jobs: feeBearing.length,
        fee_gross_usd: roundUsd(
            feeBearing.reduce((a, r) => a + (Number(r.gross_usd) || Number(r.amount_usd) || 0), 0)
        ),
        subsidised_usd: roundUsd(
            confirmed.filter((e) => e.kind === "subsidy").reduce((a, r) => a + (Number(r.amount_usd) || 0), 0)
        )
    };
}

export function fmtAmount(n) {
    const v = Number(n) || 0;
    if (v === 0) return "0.00";
    if (Math.abs(v) >= 0.01) return v.toFixed(2);
    return v.toFixed(6).replace(/0+$/, "");
}

export function fmtUsdPrecise(n) {
    return `$${fmtAmount(n)}`;
}

export const EARNING_KIND_LABELS = {
    paid: "paid job",
    subsidy: "house subsidy",
    reservation: "reservation",
    spent_on_compute: "spent on compute"
};

export const EARNING_STATUS_LABELS = {
    pending_approval: "pending approval",
    pending: "awaiting client payment",
    confirmed: "confirmed",
    void: "void"
};
