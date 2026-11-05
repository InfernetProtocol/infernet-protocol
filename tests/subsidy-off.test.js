import { describe, it, expect } from "vitest";
import { computeJobCredits, resolveEarningsConfig } from "../apps/web/lib/earnings/core.js";

/**
 * The subsidy is off (Anthony, 2026-11-05: "stop the subsidy and just pay for
 * your own shit"). The house paid $19.22 across 5,311 free jobs, 98% of it to
 * Anthony's own nodes, before the rate was set to 0.
 *
 * With the rate at 0 a free job must credit NOTHING AT ALL, not a row worth
 * $0.00: thousands of zero rows would be read past by every balance query, and
 * would tell an operator they earned nothing on a job rather than being honest
 * that free traffic is not paid for.
 */

const config = (over) => resolveEarningsConfig({ env: {}, settings: { subsidy_per_1k_output_usd: 0, subsidy_approved: true, ...over } });
const job = (o = {}) => ({ id: "job-1", provider_id: "p1", payment_offer: 0, ...o });
const result = { text: "x".repeat(4000) };

describe("with the subsidy stopped", () => {
    it("writes no row at all for a free job", () => {
        expect(computeJobCredits({ job: job(), result, config: config() })).toEqual([]);
    });

    it("writes no row even for a big free job", () => {
        const rows = computeJobCredits({
            job: job({ max_tokens: 4096 }),
            result: { text: "y".repeat(400_000) },
            config: config()
        });
        expect(rows).toEqual([]);
    });

    it("still pays a job the customer actually paid for", () => {
        const rows = computeJobCredits({
            job: job({ payment_offer: 1, payment_status: "confirmed" }),
            result,
            config: config()
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: "paid", status: "confirmed" });
        expect(Number(rows[0].amount_usd)).toBeGreaterThan(0);
    });

    it("pays again the moment the rate is turned back on", () => {
        const rows = computeJobCredits({ job: job(), result, config: config({ subsidy_per_1k_output_usd: 0.01 }) });
        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe("subsidy");
        expect(Number(rows[0].amount_usd)).toBeGreaterThan(0);
    });

    it("treats a malformed rate as off rather than as free money", () => {
        for (const bad of [null, "", "abc", -1]) {
            const rows = computeJobCredits({
                job: job(),
                result,
                config: { ...config(), subsidy_per_1k_output_usd: bad }
            });
            expect(rows).toEqual([]);
        }
    });

    it("leaves the prepaid-batch and reservation paths alone", () => {
        expect(computeJobCredits({ job: job({ batch_item_id: "i1" }), result, config: config() })).toEqual([]);
        expect(computeJobCredits({ job: job({ reservation_id: "r1" }), result, config: config() })).toEqual([]);
    });
});
