import { describe, expect, it } from "vitest";
import {
    resolveEarningsConfig,
    computeJobCredits,
    summariseBalance,
    checkPayoutRequest,
    outputTokensFor,
    normaliseShares,
    fmtAmount,
    DEFAULT_EARNINGS_CONFIG
} from "@/lib/earnings/core";

const cfg = (over = {}) => ({ ...DEFAULT_EARNINGS_CONFIG, ...over });

describe("resolveEarningsConfig", () => {
    it("defaults are conservative: subsidy not approved, 10% house fee", () => {
        const c = resolveEarningsConfig({ env: {} });
        expect(c.subsidy_approved).toBe(false);
        expect(c.house_fee_pct).toBe(10);
        expect(c.subsidy_per_1k_output_usd).toBeGreaterThan(0);
        expect(c.min_payout_usd).toBeGreaterThan(0);
    });

    it("settings override env, env overrides defaults; garbage falls through", () => {
        const env = { INFERNET_SUBSIDY_PER_1K_OUTPUT_USD: "0.002", INFERNET_HOUSE_FEE_PCT: "5" };
        const c = resolveEarningsConfig({ env, settings: { house_fee_pct: 10, subsidy_per_1k_output_usd: "nope", min_payout_usd: -3 } });
        expect(c.subsidy_per_1k_output_usd).toBe(0.002);
        expect(c.house_fee_pct).toBe(10);
        expect(c.min_payout_usd).toBe(DEFAULT_EARNINGS_CONFIG.min_payout_usd);
    });

    it("a fee above 100% can never mint negative credits", () => {
        expect(resolveEarningsConfig({ env: {}, settings: { house_fee_pct: 250 } }).house_fee_pct).toBe(10);
    });
});

describe("outputTokensFor", () => {
    it("prefers the daemon's token_count, else estimates 4 chars/token", () => {
        expect(outputTokensFor({ token_count: 312, text: "x" })).toBe(312);
        expect(outputTokensFor({ text: "abcdefghi" })).toBe(3);
        expect(outputTokensFor(null)).toBe(0);
    });
});

describe("computeJobCredits", () => {
    const job = { id: "j1", provider_id: "p1", payment_offer: 0, model_name: "qwen2.5:7b" };

    it("a free job earns the subsidy, pending approval", () => {
        const [row] = computeJobCredits({ job, result: { token_count: 2000 }, config: cfg({ subsidy_per_1k_output_usd: 0.001 }) });
        expect(row).toMatchObject({ job_id: "j1", provider_id: "p1", kind: "subsidy", status: "pending_approval", output_tokens: 2000 });
        expect(row.amount_usd).toBeCloseTo(0.002, 10);
        expect(row.rate_per_1k_usd).toBe(0.001);
    });

    it("an approved subsidy is confirmed immediately", () => {
        const [row] = computeJobCredits({ job, result: { token_count: 1000 }, config: cfg({ subsidy_approved: true }) });
        expect(row.status).toBe("confirmed");
        expect(row.confirmed_at).toBeTruthy();
    });

    it("a paid job credits the offer minus the house fee, pending until the client pays", () => {
        const paid = { ...job, payment_offer: "2.0000", payment_coin: "USDC" };
        const [row] = computeJobCredits({ job: paid, result: {}, config: cfg({ house_fee_pct: 10 }) });
        expect(row).toMatchObject({ kind: "paid", status: "pending", coin: "USDC", rate_per_1k_usd: null });
        expect(row.gross_usd).toBe(2);
        expect(row.fee_usd).toBeCloseTo(0.2, 10);
        expect(row.amount_usd).toBeCloseTo(1.8, 10);
        const [confirmed] = computeJobCredits({ job: { ...paid, payment_status: "confirmed" }, config: cfg() });
        expect(confirmed.status).toBe("confirmed");
    });

    it("multi-provider jobs split by share and sum to the job total less the house fee", () => {
        const shares = [
            { provider_id: "p1", share: 1 / 3, role: "primary" },
            { provider_id: "p2", share: 2 / 9, role: "slice" },
            { provider_id: "p3", share: 4 / 9, role: "slice" }
        ];
        const rows = computeJobCredits({ job: { ...job, payment_offer: 9 }, shares, config: cfg() });
        expect(rows.map((r) => r.provider_id)).toEqual(["p1", "p2", "p3"]);
        expect(rows.reduce((a, r) => a + r.amount_usd, 0)).toBeCloseTo(8.1, 6);
        expect(rows.reduce((a, r) => a + r.fee_usd, 0)).toBeCloseTo(0.9, 6);
        expect(rows[0].role).toBe("primary");
    });

    it("no provider, no credit", () => {
        expect(computeJobCredits({ job: { id: "j", provider_id: null }, config: cfg() })).toEqual([]);
    });
});

describe("normaliseShares", () => {
    it("merges a provider listed twice and renormalises", () => {
        const out = normaliseShares([
            { provider_id: "a", share: 0.25, role: "primary" },
            { provider_id: "a", share: 0.25, role: "slice" },
            { provider_id: "b", share: 0.25, role: "slice" }
        ]);
        expect(out).toEqual([
            { provider_id: "a", share: 2 / 3, role: "primary" },
            { provider_id: "b", share: 1 / 3, role: "slice" }
        ]);
    });
});

describe("summariseBalance + checkPayoutRequest", () => {
    const earnings = [
        { status: "confirmed", amount_usd: 10 },
        { status: "confirmed", amount_usd: "2.5" },
        { status: "pending_approval", amount_usd: 1 },
        { status: "pending", amount_usd: 3 }
    ];

    it("available = confirmed - open requests - paid", () => {
        const b = summariseBalance(earnings, [
            { status: "sent", amount_usd: 5 },
            { status: "requested", amount_usd: 2 },
            { status: "rejected", amount_usd: 100 },
            { status: "failed", amount_usd: 100 }
        ]);
        expect(b).toMatchObject({
            confirmed_usd: 12.5, pending_approval_usd: 1, pending_usd: 3,
            paid_usd: 5, requested_usd: 2, available_usd: 5.5, jobs_credited: 4
        });
    });

    it("refuses without an address, below the minimum, above the balance, or with one open", () => {
        const balance = { available_usd: 7 };
        const c = cfg({ min_payout_usd: 5 });
        expect(checkPayoutRequest({ balance, config: c, hasAddress: false }).ok).toBe(false);
        expect(checkPayoutRequest({ balance, config: c, hasAddress: true, hasOpenRequest: true }).ok).toBe(false);
        expect(checkPayoutRequest({ balance, amountUsd: 4, config: c, hasAddress: true }).error).toMatch(/minimum/);
        expect(checkPayoutRequest({ balance, amountUsd: 8, config: c, hasAddress: true }).error).toMatch(/more than/);
        expect(checkPayoutRequest({ balance: { available_usd: 0 }, config: c, hasAddress: true }).error).toMatch(/nothing confirmed/);
        expect(checkPayoutRequest({ balance, config: c, hasAddress: true })).toEqual({ ok: true, amount: 7 });
    });
});

describe("fmtAmount", () => {
    it("never shows a real sub-cent credit as 0.00", () => {
        expect(fmtAmount(0)).toBe("0.00");
        expect(fmtAmount(0.000135)).toBe("0.000135");
        expect(fmtAmount(0.0042)).toBe("0.0042");
        expect(fmtAmount(12.5)).toBe("12.50");
    });
});
