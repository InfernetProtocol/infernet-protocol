import { describe, it, expect } from "vitest";
import { summariseNetworkEarnings } from "../apps/web/lib/earnings/core.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();
const job = (provider_id, amount, h, extra = {}) => ({
    id: `${provider_id}-${amount}-${h}`, provider_id, kind: "job", status: "confirmed",
    amount_usd: amount, fee_usd: amount / 19, gross_usd: amount * 20 / 19, created_at: ago(h), ...extra
});

describe("summariseNetworkEarnings", () => {
    const earnings = [
        job("p1", 0.95, 1),
        job("p1", 1.90, 50),
        job("p2", 0.38, 2),
        job("p3", 3.80, 24 * 20),
        job("p3", 9.99, 24 * 60, { status: "void" }),          // voided: never counted
        { id: "s", provider_id: "p4", kind: "subsidy", status: "confirmed", amount_usd: 50, created_at: ago(1) }, // house subsidy: not earnings
        { id: "f", provider_id: "house", kind: "platform_fee", status: "confirmed", amount_usd: 0.37, created_at: ago(1) }
    ];
    const payouts = [{ id: "x", status: "sent", amount_usd: 1 }, { id: "y", status: "pending", amount_usd: 5 }];
    const commissions = [
        { id: "c1", referrer_user_id: "r1", status: "confirmed", amount_usd: 0.002, earned_at: ago(1) },
        { id: "c2", referrer_user_id: "r2", status: "pending", amount_usd: 0.001, earned_at: ago(24 * 10) },
        { id: "c3", referrer_user_id: "r3", status: "void", amount_usd: 1, earned_at: ago(1) }
    ];
    const s = summariseNetworkEarnings(earnings, payouts, commissions, NOW);

    it("all time leaves out void and subsidy rows", () => {
        expect(s.all_time.earned_usd).toBeCloseTo(0.95 + 1.9 + 0.38 + 3.8, 8);
        expect(s.all_time.earning_nodes).toBe(3);
        expect(s.all_time.best_node_usd).toBeCloseTo(3.8, 8);
        expect(s.all_time.median_node_usd).toBeCloseTo(2.85, 8);
        expect(s.all_time.paid_out_usd).toBe(1);
        expect(s.all_time.house_fee_usd).toBeCloseTo(0.37, 8);
    });

    it("commissions skip void rows and count referrers", () => {
        expect(s.all_time.commissions_usd).toBeCloseTo(0.003, 8);
        expect(s.all_time.commissions_confirmed_usd).toBeCloseTo(0.002, 8);
        expect(s.all_time.earning_referrers).toBe(2);
    });

    it("windows only count rows inside them", () => {
        expect(s.windows["24h"].earned_usd).toBeCloseTo(0.95 + 0.38, 8);
        expect(s.windows["24h"].earning_nodes).toBe(2);
        expect(s.windows["7d"].earned_usd).toBeCloseTo(0.95 + 1.9 + 0.38, 8);
        expect(s.windows["30d"].earned_usd).toBeCloseTo(0.95 + 1.9 + 0.38 + 3.8, 8);
        expect(s.windows["24h"].commissions_usd).toBeCloseTo(0.002, 8);
        expect(s.windows["30d"].commissions_usd).toBeCloseTo(0.003, 8);
    });

    it("names nobody", () => {
        const text = JSON.stringify(s);
        for (const id of ["p1", "p2", "p3", "r1", "r2"]) expect(text).not.toContain(`"${id}"`);
    });

    it("empty ledger is all zeros", () => {
        const e = summariseNetworkEarnings([], [], [], NOW);
        expect(e.all_time.earned_usd).toBe(0);
        expect(e.windows["24h"].median_node_usd).toBe(0);
    });
});
