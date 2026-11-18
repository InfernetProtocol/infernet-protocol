import { describe, it, expect } from "vitest";
import { summariseFees, summariseNetworkMoney } from "../apps/web/lib/earnings/core.js";

/**
 * Platform fees on the status page.
 *
 * Every charge splits one way: the provider keeps amount_usd, the house keeps
 * fee_usd, and together they are gross_usd. So the platform's revenue is the
 * sum of fee_usd and there is no second ledger to reconcile. These pin the
 * parts that would quietly overstate it.
 */

const row = (o) => ({ status: "confirmed", kind: "paid", amount_usd: 0, fee_usd: 0, gross_usd: 0, ...o });

describe("summariseFees", () => {
    it("is the sum of the house's cut", () => {
        const f = summariseFees([
            row({ amount_usd: 0.8, fee_usd: 0.2, gross_usd: 1 }),
            row({ amount_usd: 1.6, fee_usd: 0.4, gross_usd: 2 })
        ]);
        expect(f.fees_usd).toBeCloseTo(0.6, 8);
        expect(f.fee_jobs).toBe(2);
        expect(f.fee_gross_usd).toBeCloseTo(3, 8);
    });

    it("counts only confirmed rows, because a pending fee is not money yet", () => {
        const f = summariseFees([
            row({ fee_usd: 0.2, gross_usd: 1, status: "confirmed" }),
            row({ fee_usd: 5, gross_usd: 10, status: "pending" }),
            row({ fee_usd: 9, gross_usd: 10, status: "pending_approval" }),
            row({ fee_usd: 7, gross_usd: 10, status: "void" })
        ]);
        expect(f.fees_usd).toBeCloseTo(0.2, 8);
        expect(f.fee_jobs).toBe(1);
    });

    it("ignores subsidy rows: the house paying its own nodes is not a fee", () => {
        const f = summariseFees([
            row({ kind: "subsidy", amount_usd: 18.35, fee_usd: 0, gross_usd: 18.35 }),
            row({ kind: "paid", amount_usd: 0.95, fee_usd: 0.05, gross_usd: 1 })
        ]);
        expect(f.fees_usd).toBeCloseTo(0.05, 8);
        expect(f.fee_jobs).toBe(1);
        expect(f.fee_gross_usd).toBeCloseTo(1, 8);
        expect(f.subsidised_usd).toBeUndefined();
    });

    it("reports the effective fee rate against what was billed", () => {
        expect(summariseFees([row({ amount_usd: 0.95, fee_usd: 0.05, gross_usd: 1 })]).fee_pct).toBe(5);
        // Rows from the 20% era blend the lifetime rate above 5%.
        expect(summariseFees([
            row({ amount_usd: 0.95, fee_usd: 0.05, gross_usd: 1 }),
            row({ amount_usd: 0.8, fee_usd: 0.2, gross_usd: 1 })
        ]).fee_pct).toBe(12.5);
        expect(summariseFees([]).fee_pct).toBe(0);
    });

    it("survives rows with no fee columns at all", () => {
        const f = summariseFees([{ status: "confirmed", kind: "subsidy", amount_usd: 2 }]);
        expect(f.fees_usd).toBe(0);
        expect(f.fee_jobs).toBe(0);
    });
});

describe("summariseNetworkMoney carries the fees", () => {
    it("reports fees beside what nodes earned, without double counting or subsidy", () => {
        const earnings = [
            row({ provider_id: "p1", kind: "paid", amount_usd: 0.95, fee_usd: 0.05, gross_usd: 1 }),
            row({ provider_id: "p1", kind: "subsidy", amount_usd: 3, fee_usd: 0, gross_usd: 3 }),
            row({ provider_id: "p2", kind: "subsidy", amount_usd: 1, fee_usd: 0, gross_usd: 1, status: "pending_approval" })
        ];
        const m = summariseNetworkMoney(earnings, []);
        // Nodes earned their share of paid work; the fee is the house's.
        expect(m.earned_usd).toBeCloseTo(0.95, 8);
        expect(m.earned_pending_usd).toBe(0);
        expect(m.fees_usd).toBeCloseTo(0.05, 8);
        expect(m.fee_pct).toBe(5);
        expect(m.earning_nodes).toBe(1);
    });

    it("matches the live ledger on 2026-11-18", () => {
        // $19.22 of house subsidy used to read as $21.10 "earned by nodes".
        const m = summariseNetworkMoney(
            [
                row({ provider_id: "p1", kind: "subsidy", amount_usd: 19.217, fee_usd: 0, gross_usd: 19.217 }),
                row({ provider_id: "p1", kind: "paid", amount_usd: 1.8866, fee_usd: 0.132, gross_usd: 2.0186 })
            ],
            []
        );
        expect(m.earned_usd).toBeCloseTo(1.8866, 6);
        expect(m.fees_usd).toBeCloseTo(0.132, 6);
    });
});
