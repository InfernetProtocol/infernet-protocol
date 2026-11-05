/**
 * Revenue analytics (PR-13): what outside buyers really paid us, and where it
 * went. Pure aggregation; lib/data/revenue.js fetches the rows.
 *
 * Counted (external, paid):
 *   - self-serve reservation orders that were paid (paid_at in the window):
 *     GMV is fulfilled orders' total_usd less what was refunded
 *   - jobs whose client payment CoinPay confirmed (payment_offer > 0)
 *   - prepaid batch inference CHARGES (settled items, settled_at in the
 *     window), whatever funded them: prepaid top-up, wallet, or the buyer's
 *     own node earnings. Top-ups are NOT GMV (money in, nothing sold yet).
 *     Platform fee = charge less the provider's 'paid' credit.
 * Platform fee: what stays with the house. A node order keeps the setup fee
 *   plus the house fee on the hours (total less the operator's reservation
 *   credit); a RENTED order (SaladCloud, Vast.ai, Thunder Compute) keeps its
 *   whole total, because no operator is paid out of it and the cloud's own
 *   bill is not in this ledger — so this figure is gross of what we pay the
 *   cloud, not profit; a paid job keeps the fee_usd on its 'paid' credits.
 * Refunds: due (owed, not yet paid back) and refunded.
 * Provider payouts: payout requests marked sent in the window.
 *
 * Never counted: the house subsidy (free jobs, we pay it), jobs served by the
 * hosted NIM fallback (provider_id null), unpaid jobs (playground, traffic on
 * a reservation), admin-created post-paid reservations (billed outside this
 * system), and internal usage: orders from our own emails / payer addresses.
 */
import { roundUsd } from "./core.js";

const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

export function isInternalOrder(order, internal = {}) {
    const emails = (internal.emails ?? []).map(lower);
    const payers = (internal.payers ?? []).map(lower);
    const email = lower(order?.email);
    const payer = lower(order?.payer);
    return Boolean((email && emails.includes(email)) || (payer && payers.includes(payer)));
}

/**
 * @param {object} p
 * @param {Array} p.orders        reservation_orders paid in the window
 *                                { id, status, provider_id, total_usd, setup_fee, refund_state, email, payer, reservation_id }
 * @param {Array} p.jobs          jobs with payment confirmed in the window { id, provider_id, payment_offer }
 * @param {Array} p.earnings      provider_earnings for those orders' reservations and jobs
 *                                { kind, job_id, reservation_id, amount_usd, fee_usd, status }
 * @param {Array} p.payouts       payout_requests sent in the window { amount_usd }
 * @param {Array} [p.subsidy]     subsidy credits earned in the window { amount_usd, status } (reported as excluded)
 * @param {object} p.config       resolveEarningsConfig() output (house_fee_pct fallback)
 * @param {object} [p.internal]   { emails: [], payers: [] }
 * @param {Array} [p.batchCharges] settled batch items { cost_usd, provider_usd|null, email }
 */
export function summariseRevenue({ orders = [], jobs = [], earnings = [], payouts = [], subsidy = [], config = {}, internal = {}, batchCharges = [] } = {}) {
    const sum = (rows, f) => roundUsd(rows.reduce((a, r) => a + (Number(f(r)) || 0), 0));
    const feePct = Number(config.house_fee_pct) || 0;
    const live = earnings.filter((e) => e.status !== "void");
    const resCredit = new Map(live.filter((e) => e.kind === "reservation").map((e) => [e.reservation_id, Number(e.amount_usd) || 0]));
    const jobFees = new Map();
    for (const e of live.filter((x) => x.kind === "paid")) {
        jobFees.set(e.job_id, (jobFees.get(e.job_id) ?? 0) + (Number(e.fee_usd) || 0));
    }

    const internalOrders = orders.filter((o) => isInternalOrder(o, internal));
    const external = orders.filter((o) => !isInternalOrder(o, internal));
    const fulfilled = external.filter((o) => o.status === "fulfilled");
    const refunded = external.filter((o) => o.refund_state === "refunded");
    const due = external.filter((o) => o.refund_state === "due");
    // Kept revenue: fulfilled and not refunded.
    const kept = fulfilled.filter((o) => o.refund_state !== "refunded");
    const node = kept.filter((o) => o.provider_id);
    // No provider_id means no node operator to pay: a rented-GPU order.
    const rented = kept.filter((o) => !o.provider_id);
    const nodeOperatorShare = (o) => {
        if (resCredit.has(o.reservation_id)) return resCredit.get(o.reservation_id);
        const total = Number(o.total_usd) || 0;
        const setup = Math.min(Number(o.setup_fee) || 0, total);
        return (total - setup) * (1 - feePct / 100);
    };

    const paidJobs = jobs.filter((j) => j.provider_id && Number(j.payment_offer) > 0);
    const nimJobs = jobs.filter((j) => !j.provider_id);

    const orderGmv = roundUsd(sum(fulfilled, (o) => o.total_usd) - sum(fulfilled.filter((o) => o.refund_state === "refunded"), (o) => o.total_usd));
    const jobGmv = sum(paidJobs, (j) => j.payment_offer);
    const nodeFee = roundUsd(sum(node, (o) => o.total_usd) - sum(node, nodeOperatorShare));
    const rentedFee = sum(rented, (o) => o.total_usd);
    const jobFee = sum(paidJobs, (j) => (jobFees.has(j.id) ? jobFees.get(j.id) : Number(j.payment_offer) * (feePct / 100)));

    const internalEmails = (internal.emails ?? []).map(lower);
    const isInternalBatch = (c) => Boolean(lower(c?.email) && internalEmails.includes(lower(c.email)));
    const extBatch = batchCharges.filter((c) => !isInternalBatch(c));
    const intBatch = batchCharges.filter(isInternalBatch);
    const batchGmv = sum(extBatch, (c) => c.cost_usd);
    const batchProvider = sum(extBatch, (c) => (c.provider_usd === null || c.provider_usd === undefined
        ? Number(c.cost_usd) * (1 - feePct / 100) : c.provider_usd));
    const batchFee = roundUsd(batchGmv - batchProvider);

    return {
        gmv_usd: roundUsd(orderGmv + jobGmv + batchGmv),
        orders: {
            paid_count: external.length,
            paid_usd: sum(external, (o) => o.total_usd),
            fulfilled_count: fulfilled.length,
            gmv_usd: orderGmv,
            node_usd: sum(node, (o) => o.total_usd),
            rented_usd: rentedFee,
            operator_share_usd: sum(node, nodeOperatorShare)
        },
        jobs: { paid_count: paidJobs.length, gmv_usd: jobGmv },
        platform_fee_usd: roundUsd(nodeFee + rentedFee + jobFee + batchFee),
        batches: {
            charged_items: extBatch.length,
            gmv_usd: batchGmv,
            provider_share_usd: batchProvider,
            platform_fee_usd: batchFee,
            internal_items: intBatch.length,
            internal_usd: sum(intBatch, (c) => c.cost_usd)
        },
        platform_fee: { node_orders_usd: nodeFee, rented_orders_usd: rentedFee, paid_jobs_usd: jobFee },
        refunds: {
            due_count: due.length,
            due_usd: sum(due, (o) => o.total_usd),
            refunded_count: refunded.length,
            refunded_usd: sum(refunded, (o) => o.total_usd)
        },
        provider_payouts_sent_usd: sum(payouts, (p) => p.amount_usd),
        provider_payouts_sent_count: payouts.length,
        excluded: {
            subsidy_usd: sum(subsidy.filter((s) => s.status !== "void"), (s) => s.amount_usd),
            subsidy_credits: subsidy.length,
            nim_fallback_jobs: nimJobs.length,
            internal_orders: internalOrders.length,
            internal_orders_usd: sum(internalOrders, (o) => o.total_usd)
        }
    };
}
