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

    it("earns nothing on a subsidised job, and reports what the house paid instead", () => {
        const f = summariseFees([
            row({ kind: "subsidy", amount_usd: 18.35, fee_usd: 0, gross_usd: 18.35 }),
            row({ kind: "paid", amount_usd: 0.8, fee_usd: 0.2, gross_usd: 1 })
        ]);
        // A subsidy carries no fee by definition: the house is buying that
        // traffic, not taking a cut of it.
        expect(f.fees_usd).toBeCloseTo(0.2, 8);
        expect(f.fee_jobs).toBe(1);
        expect(f.subsidised_usd).toBeCloseTo(18.35, 8);
    });

    it("reports zero honestly rather than hiding the row", () => {
        const f = summariseFees([row({ kind: "subsidy", amount_usd: 1, fee_usd: 0, gross_usd: 1 })]);
        expect(f.fees_usd).toBe(0);
        expect(f.fee_jobs).toBe(0);
        expect(f.subsidised_usd).toBeCloseTo(1, 8);
    });

    it("survives rows with no fee columns at all", () => {
        const f = summariseFees([{ status: "confirmed", kind: "subsidy", amount_usd: 2 }]);
        expect(f.fees_usd).toBe(0);
        expect(f.fee_jobs).toBe(0);
    });
});

describe("summariseNetworkMoney carries the fees", () => {
    it("reports fees beside what nodes earned, without double counting", () => {
        const earnings = [
            row({ provider_id: "p1", kind: "paid", amount_usd: 0.8, fee_usd: 0.2, gross_usd: 1 }),
            row({ provider_id: "p1", kind: "subsidy", amount_usd: 3, fee_usd: 0, gross_usd: 3 }),
            row({ provider_id: "p2", kind: "subsidy", amount_usd: 1, fee_usd: 0, gross_usd: 1, status: "pending_approval" })
        ];
        const m = summariseNetworkMoney(earnings, []);
        // Nodes earned their share; the fee is the house's and is NOT in it.
        expect(m.earned_confirmed_usd).toBeCloseTo(3.8, 8);
        expect(m.fees_usd).toBeCloseTo(0.2, 8);
        expect(m.subsidised_usd).toBeCloseTo(3, 8);
        expect(m.earning_nodes).toBe(2);
    });

    it("matches the live shape of the network today", () => {
        // The real prod numbers on 2026-11-05: a huge subsidy bill and almost
        // no fee revenue, which is the thing the card has to be able to say.
        const m = summariseNetworkMoney(
            [
                row({ provider_id: "p1", kind: "subsidy", amount_usd: 18.34718, fee_usd: 0, gross_usd: 18.34718 }),
                row({ provider_id: "p1", kind: "paid", amount_usd: 0.000004, fee_usd: 0.000002, gross_usd: 0.000006 })
            ],
            []
        );
        expect(m.fees_usd).toBeCloseTo(0.000002, 8);
        expect(m.subsidised_usd).toBeCloseTo(18.34718, 6);
        expect(m.fee_jobs).toBe(1);
    });
});
