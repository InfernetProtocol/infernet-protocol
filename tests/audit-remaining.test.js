import { describe, expect, it } from "vitest";
import {
    outputTokenCount, outputTokensFor, outlierReason, splitSubsidyOutliers, applyOutlierHolds,
    computeJobCredits, computeReservationCredit, median, MAX_CREDITED_OUTPUT_TOKENS, OUTLIER_FLOOR_TOKENS, DEFAULT_EARNINGS_CONFIG
} from "../apps/web/lib/earnings/core.js";
import { summariseRevenue, isInternalOrder } from "../apps/web/lib/earnings/revenue.js";
import { resolveModelDenylist, resolveOrderBlocklist, deniedModel, orderBlockReason } from "../apps/web/lib/moderation/blocklists.js";
import { isJobOwner, reusableCheckout, CHECKOUT_TTL_MS } from "../apps/web/lib/payments/invoice.js";
import { tokenReservationFor, buildInvoice, buildReport, DEFAULT_TOKEN_RESERVE } from "../apps/web/lib/reservations/core.js";
import { verifyOrderPaymentDetail, verifyOrderPayment, txHashOf } from "../apps/web/lib/reservations/payment-check.js";
import { renderInvoice } from "../apps/cli/lib/reservations-client.js";

const cfg = (over = {}) => ({ ...DEFAULT_EARNINGS_CONFIG, ...over });

describe("1. subsidy token counts", () => {
    it("clamps to max_tokens, else to the hard ceiling, and says when it estimated", () => {
        expect(outputTokenCount({ token_count: 5000 }, { maxTokens: 512 })).toEqual({ tokens: 512, estimated: false, reported: 5000, clamped: true });
        expect(outputTokenCount({ token_count: 1e9 }).tokens).toBe(MAX_CREDITED_OUTPUT_TOKENS);
        expect(outputTokenCount({ token_count: 1e9 }, { maxTokens: 1e9 }).tokens).toBe(MAX_CREDITED_OUTPUT_TOKENS);
        expect(outputTokenCount({ text: "abcdefgh" })).toEqual({ tokens: 2, estimated: true, reported: 2, clamped: false });
        expect(outputTokenCount({ text: "x".repeat(4000) }, { maxTokens: 10 }).tokens).toBe(10);
        expect(outputTokenCount(null)).toMatchObject({ tokens: 0, estimated: false });
        expect(outputTokensFor({ token_count: 100 }, { maxTokens: 50 })).toBe(50);
    });

    it("computeJobCredits records the clamp and the estimate", () => {
        const [row] = computeJobCredits({ job: { id: "j", provider_id: "p", payment_offer: 0, max_tokens: 100 }, result: { token_count: 900 }, config: cfg() });
        expect(row).toMatchObject({ output_tokens: 100, tokens_estimated: false, held_reason: null });
        expect(row.metadata).toMatchObject({ reported_tokens: 900, clamped_to: 100 });
        const [est] = computeJobCredits({ job: { id: "j", provider_id: "p", payment_offer: 0 }, result: { text: "abcd" }, config: cfg() });
        expect(est.tokens_estimated).toBe(true);
        expect(est.metadata).not.toHaveProperty("reported_tokens");
    });

    it("a reservation job earns no subsidy, but a paid one still earns its payment", () => {
        expect(computeJobCredits({ job: { id: "j", provider_id: "p", payment_offer: 0, reservation_id: "r" }, result: { token_count: 9 }, config: cfg() })).toEqual([]);
        expect(computeJobCredits({ job: { id: "j", provider_id: "p", payment_offer: 1, reservation_id: "r" }, config: cfg() })).toHaveLength(1);
    });

    it("outliers: above 3x the provider's median, or above the ceiling", () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([1, 2, 3, 4])).toBe(2.5);
        expect(median([])).toBeNull();
        const hist = [1000, 1200, 900, 1100, 1000];
        expect(outlierReason(3000, hist)).toBeNull();
        expect(outlierReason(3001, hist)).toMatch(/3x provider median 1000/);
        expect(outlierReason(25000, [1000, 1000])).toBeNull(); // too little history
        expect(outlierReason(MAX_CREDITED_OUTPUT_TOKENS + 1, [])).toMatch(/ceiling/);
    });

    it("never holds a credit at or below the token floor, however small the median", () => {
        const pings = [10, 10, 16, 16, 12, 10, 16];
        expect(outlierReason(49, pings)).toBeNull();
        expect(outlierReason(OUTLIER_FLOOR_TOKENS, pings)).toBeNull();
        expect(outlierReason(OUTLIER_FLOOR_TOKENS + 1, pings)).toMatch(/3x provider median/);
        expect(outlierReason(5000, pings, { floor: 0 })).toMatch(/3x provider median/);
    });

    it("splitSubsidyOutliers keeps outliers and already-held rows pending", () => {
        const rows = [
            ...[1, 2, 3, 4, 5].map((i) => ({ id: `a${i}`, provider_id: "A", output_tokens: 1000 })),
            { id: "a-big", provider_id: "A", output_tokens: 10000 },
            { id: "b1", provider_id: "B", output_tokens: 1000 },
            { id: "held", provider_id: "B", output_tokens: 10, held_reason: "manual" }
        ];
        const { confirm, hold } = splitSubsidyOutliers(rows);
        expect(confirm.sort()).toEqual(["a1", "a2", "a3", "a4", "a5", "b1"]);
        expect(hold.map((h) => h.id).sort()).toEqual(["a-big", "held"]);
    });

    it("applyOutlierHolds only holds subsidy rows", () => {
        const rows = [
            { kind: "subsidy", provider_id: "A", output_tokens: 9000, status: "confirmed", confirmed_at: "x" },
            { kind: "paid", provider_id: "A", output_tokens: 9000, status: "confirmed" }
        ];
        const out = applyOutlierHolds(rows, { A: [1000, 1000, 1000, 1000, 1000] });
        expect(out[0]).toMatchObject({ status: "pending_approval", confirmed_at: null });
        expect(out[0].held_reason).toMatch(/median/);
        expect(out[1].status).toBe("confirmed");
    });
});

describe("2. reservation earnings", () => {
    const order = { id: "o", provider_id: "p", total_usd: 12.92, setup_fee: 6.98, hours: 3, models: ["m"], paid_at: "2026-11-02T00:00:00Z" };
    it("is the hours less the house fee, pending approval, keyed by reservation", () => {
        const row = computeReservationCredit({ order, reservationId: "r", config: cfg({ house_fee_pct: 2 }) });
        expect(row).toMatchObject({
            job_id: null, reservation_id: "r", provider_id: "p", kind: "reservation", status: "pending_approval",
            gross_usd: 5.94, fee_usd: 0.1188, amount_usd: 5.8212, confirmed_at: null, earned_at: order.paid_at
        });
        expect(row.metadata).toMatchObject({ order_id: "o", house_fee_pct: 2, setup_fee: 6.98 });
    });
    it("uses the configured fee and never goes negative", () => {
        expect(computeReservationCredit({ order, reservationId: "r", config: cfg({ house_fee_pct: 10 }) }).amount_usd).toBe(5.346);
        expect(computeReservationCredit({ order: { ...order, setup_fee: 50 }, reservationId: "r", config: cfg() })).toBeNull();
        expect(computeReservationCredit({ order: { ...order, provider_id: null }, reservationId: "r", config: cfg() })).toBeNull();
        expect(computeReservationCredit({ order, reservationId: null, config: cfg() })).toBeNull();
    });
});

describe("3. kill-switch lists", () => {
    it("normalises lists and matches any name of a model", () => {
        expect(resolveModelDenylist(["a", " a ", "", 5, "B"])).toEqual({ models: ["a", "B"] });
        expect(resolveModelDenylist(null)).toEqual({ models: [] });
        const dl = resolveModelDenylist({ models: ["Qwen2.5:7B"] });
        expect(deniedModel(dl, "qwen2.5:7b")).toBe("qwen2.5:7b");
        expect(deniedModel(dl, ["llama3", "qwen2.5:7b"])).toBe("qwen2.5:7b");
        expect(deniedModel(dl, "llama3")).toBeNull();
        expect(deniedModel({ models: [] }, "x")).toBeNull();
    });
    it("blocks order emails, whole domains and payer addresses", () => {
        const bl = resolveOrderBlocklist({ emails: ["Bad@Example.com", "@spam.test"], payers: ["0xABC"] });
        expect(bl).toEqual({ emails: ["bad@example.com", "@spam.test"], payers: ["0xabc"] });
        expect(orderBlockReason(bl, { email: "bad@example.com" })).toBe("email");
        expect(orderBlockReason(bl, { email: "x@spam.test" })).toBe("email");
        expect(orderBlockReason(bl, { payer: "0xAbC" })).toBe("payer");
        expect(orderBlockReason(bl, { email: "ok@example.com", payer: "0xdef" })).toBeNull();
        expect(orderBlockReason(resolveOrderBlocklist(undefined), {})).toBeNull();
    });
});

describe("4. job invoices", () => {
    const client = { id: "c", public_key: "a".repeat(64) };
    it("only the job's client pubkey, or a user who linked it, owns the job", () => {
        expect(isJobOwner({ client, signedPubkey: "a".repeat(64) })).toBe(true);
        expect(isJobOwner({ client, linkedPubkeys: ["a".repeat(64)] })).toBe(true);
        expect(isJobOwner({ client, signedPubkey: "b".repeat(64) })).toBe(false);
        expect(isJobOwner({ client: null, signedPubkey: "a".repeat(64) })).toBe(false);
        expect(isJobOwner({ client: { id: "c", public_key: null }, linkedPubkeys: [null] })).toBe(false);
    });
    it("reuses the job's open, unexpired checkout", () => {
        const now = Date.parse("2026-11-02T10:00:00Z");
        const job = { payment_status: "invoiced", payment_invoice: "cs_1" };
        const tx = {
            invoice_id: "cs_1", status: "pending", coin: "HOSTED", amount: 5, amount_usd: 5, address: "session",
            metadata: { rail: "session", hosted_url: "https://pay/cs_1", expires_at: "2026-11-02T10:30:00Z" }, created_at: "2026-11-02T09:30:00Z"
        };
        expect(reusableCheckout(job, tx, now)).toMatchObject({ invoiceId: "cs_1", paymentUrl: "https://pay/cs_1", payAddress: null, reused: true });
        expect(reusableCheckout(job, { ...tx, metadata: { ...tx.metadata, expires_at: "2026-11-02T09:59:00Z" } }, now)).toBeNull();
        expect(reusableCheckout(job, { ...tx, status: "confirmed" }, now)).toBeNull();
        expect(reusableCheckout({ ...job, payment_invoice: "cs_2" }, tx, now)).toBeNull();
        expect(reusableCheckout({ ...job, payment_status: "unpaid" }, tx, now)).toBeNull();
        const noExpiry = { ...tx, metadata: { ...tx.metadata, expires_at: null } };
        expect(reusableCheckout(job, noExpiry, Date.parse(tx.created_at) + CHECKOUT_TTL_MS - 1)).not.toBeNull();
        expect(reusableCheckout(job, noExpiry, Date.parse(tx.created_at) + CHECKOUT_TTL_MS)).toBeNull();
    });
});

describe("5. token reservation size", () => {
    it("is prompt + max_tokens, capped at the allowance; 0 without a cap", () => {
        const body = { messages: [{ role: "user", content: "x".repeat(40) }], max_tokens: 100 };
        const prompt = Math.ceil(JSON.stringify(body.messages).length / 4);
        expect(tokenReservationFor({ included_tokens: 10_000 }, body)).toBe(prompt + 100);
        expect(tokenReservationFor({ included_tokens: 50 }, body)).toBe(50);
        expect(tokenReservationFor({ included_tokens: 0 }, body)).toBe(0);
        expect(tokenReservationFor({ included_tokens: 10_000 }, { messages: [] })).toBe(1 + DEFAULT_TOKEN_RESERVE);
    });
});

describe("6. receipts", () => {
    const T0 = Date.parse("2026-11-01T00:00:00Z");
    const HOUR = 3600_000;
    const res = {
        id: "r", name: "n", operator_name: "op", models: ["m"], start_at: new Date(T0).toISOString(), hours: 2,
        required_minutes_per_hour: 60, price_per_hour: 1.98, setup_fee: 6.98, currency: "USD", status: "scheduled", gpu_class: "l40s"
    };
    const minutes = (h) => Array.from({ length: 60 }, (_, m) => ({ minute: new Date(T0 + h * HOUR + m * 60_000).toISOString(), ok: true }));
    const order = { id: "o", rail: "checkout", total_usd: 10.94, paid_at: "2026-10-31T12:00:00Z", payment_tx_hash: "0xfeed", refund_state: null };

    it("a prepaid order shows what was paid and what is refundable, never 'no payment is collected'", () => {
        const inv = buildInvoice(res, buildReport(res, minutes(0), [], T0 + 3 * HOUR), { order });
        expect(inv).toMatchObject({ billing: "prepaid", amount_paid: 10.94, amount_due: 0, refundable_usd: 1.98, payment_tx_hash: "0xfeed", hours_non_compliant: 1 });
        expect(inv.note).toMatch(/^Prepaid: 10\.94 USD paid by checkout on 2026-10-31 \(tx 0xfeed\)/);
        expect(inv.note).not.toMatch(/No payment is collected/);
        expect(renderInvoice(inv)).toMatch(/amount paid: 10\.94 USD {2}tx 0xfeed/);
        expect(renderInvoice(inv)).toMatch(/refundable: 1\.98 USD/);
    });

    it("nothing delivered: the whole prepaid total is refundable", () => {
        const inv = buildInvoice(res, buildReport(res, [], [], T0 + 3 * HOUR), { order });
        expect(inv.refundable_usd).toBe(10.94);
    });

    it("an admin reservation stays post-paid", () => {
        const inv = buildInvoice(res, buildReport(res, minutes(0), [], T0 + 3 * HOUR));
        expect(inv).toMatchObject({ billing: "post-paid", amount_due: 8.96 });
        expect(inv.note).toMatch(/^Post-paid/);
    });

    it("payment verification hands back the tx hash", async () => {
        const getPayment = async () => ({ status: "confirmed", amount_usd: "10.94", tx_hash: "0xabc" });
        expect(await verifyOrderPaymentDetail("pay_1", 10.94, { getPayment })).toEqual({ verdict: "paid", txHash: "0xabc" });
        expect(await verifyOrderPayment("pay_1", 10.94, { getPayment })).toBe("paid");
        expect(await verifyOrderPaymentDetail("pay_1", 20, { getPayment })).toEqual({ verdict: "unpaid", txHash: "0xabc" });
        const session = { getSession: async () => ({ paid: true, amount_cents: 1094, tx_hash: "0xs" }), sessionState: (s) => ({ paid: s.paid, cents: s.amount_cents }) };
        expect(await verifyOrderPaymentDetail("cs_1", 10.94, session)).toEqual({ verdict: "paid", txHash: "0xs" });
        expect(await verifyOrderPaymentDetail(null, 1, {})).toEqual({ verdict: "unpaid", txHash: null });
        expect(txHashOf({ merchant_tx_hash: " 0x1 " })).toBe("0x1");
        expect(txHashOf({})).toBeNull();
    });
});

describe("7. revenue analytics", () => {
    const orders = [
        { id: "o1", status: "fulfilled", provider_id: "p", total_usd: 12.92, setup_fee: 6.98, reservation_id: "r1", email: "buyer@x.com" },
        { id: "o2", status: "fulfilled", provider_id: null, total_usd: 20, setup_fee: 5, reservation_id: "r2", email: "b2@x.com" },
        { id: "o3", status: "fulfilled", provider_id: "p", total_usd: 10, setup_fee: 4, reservation_id: "r3", refund_state: "refunded" },
        { id: "o4", status: "failed", provider_id: "p", total_usd: 7, setup_fee: 3, refund_state: "due" },
        { id: "o5", status: "fulfilled", provider_id: "p", total_usd: 99, setup_fee: 9, reservation_id: "r5", email: "me@house.com" }
    ];
    const jobs = [
        { id: "j1", provider_id: "p", payment_offer: 4 },
        { id: "j2", provider_id: null, payment_offer: 3 }
    ];
    const earnings = [
        { kind: "reservation", reservation_id: "r1", amount_usd: 5.8212, fee_usd: 0.1188, status: "pending_approval" },
        { kind: "paid", job_id: "j1", amount_usd: 3.92, fee_usd: 0.08, status: "confirmed" }
    ];

    it("counts external paid GMV, platform fee, refunds and payouts; excludes subsidy, NIM and internal", () => {
        const out = summariseRevenue({
            orders, jobs, earnings,
            payouts: [{ amount_usd: 6 }, { amount_usd: 1.5 }],
            subsidy: [{ amount_usd: 0.5, status: "confirmed" }, { amount_usd: 9, status: "void" }],
            config: cfg({ house_fee_pct: 2 }),
            internal: { emails: ["me@house.com"] }
        });
        // GMV: fulfilled external orders 12.92 + 20 + 10 less 10 refunded, plus the paid job.
        expect(out.orders.gmv_usd).toBe(32.92);
        expect(out.jobs).toEqual({ paid_count: 1, gmv_usd: 4 });
        expect(out.gmv_usd).toBe(36.92);
        // Fee: node order 12.92 - 5.8212, the rented order keeps its whole 20, job fee 0.08.
        expect(out.platform_fee).toEqual({ node_orders_usd: 7.0988, rented_orders_usd: 20, paid_jobs_usd: 0.08 });
        expect(out.platform_fee_usd).toBe(27.1788);
        expect(out.refunds).toEqual({ due_count: 1, due_usd: 7, refunded_count: 1, refunded_usd: 10 });
        expect(out.provider_payouts_sent_usd).toBe(7.5);
        expect(out.excluded).toEqual({ subsidy_usd: 0.5, subsidy_credits: 2, nim_fallback_jobs: 1, internal_orders: 1, internal_orders_usd: 99 });
    });

    it("falls back to the configured fee when no operator credit exists", () => {
        const out = summariseRevenue({ orders: [{ ...orders[0], reservation_id: "none" }], config: cfg({ house_fee_pct: 10 }) });
        // 6.98 setup + 10% of 5.94.
        expect(out.platform_fee.node_orders_usd).toBe(7.574);
    });

    it("internal orders match by email or payer, case-insensitively", () => {
        expect(isInternalOrder({ payer: "0xAB" }, { payers: ["0xab"] })).toBe(true);
        expect(isInternalOrder({ email: "A@B.c" }, { emails: ["a@b.c"] })).toBe(true);
        expect(isInternalOrder({ email: "x@y.z" }, {})).toBe(false);
    });
});
