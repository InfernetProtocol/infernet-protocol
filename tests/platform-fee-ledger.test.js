import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    computeJobCredits, platformFeeFor, ledgerNet, summariseFees, summariseNetworkMoney, summariseBalance,
    resolveEarningsConfig, EARNINGS_SERIES_EXCLUDED_KINDS, EARNING_KIND_LABELS
} from "../apps/web/lib/earnings/core.js";
import { summariseRevenue } from "../apps/web/lib/earnings/revenue.js";

// Anthony, 2026-11-18: "where do the fees go? those be kept in our platform
// (admin) wallet right? so our balance should always be equal, no deficit".
const PLATFORM = "33a068dd-c60c-4015-821b-1e7466290f80";
const config = { ...resolveEarningsConfig({ env: {} }), house_fee_pct: 5 };

function charge(jobId, gross, shares) {
    const job = { id: jobId, provider_id: shares[0].provider_id, payment_offer: gross };
    const credits = computeJobCredits({ job, result: { token_count: 10 }, shares, config })
        .map((c, i) => ({ ...c, id: `${jobId}-c${i}`, status: "confirmed" }));
    const debit = { kind: "spent_on_compute", status: "confirmed", amount_usd: -gross };
    const fees = credits.map((c) => platformFeeFor(c, PLATFORM)).filter(Boolean);
    return { debit, credits, fees };
}

describe("platform_fee: the house fee is credited to the platform account", () => {
    it("per job: debit gross = node share + platform fee (nets to zero)", () => {
        for (const gross of [0.001, 0.0099, 0.353, 12.5]) {
            const { debit, credits, fees } = charge("j1", gross, [{ provider_id: "node-a", share: 1 }]);
            expect(fees).toHaveLength(1);
            expect(fees[0]).toMatchObject({ kind: "platform_fee", provider_id: PLATFORM, job_id: null, source_earning_id: "j1-c0", fee_usd: 0 });
            expect(ledgerNet([debit, ...credits, ...fees])).toBe(0);
            expect(credits[0].amount_usd + fees[0].amount_usd).toBeCloseTo(gross, 8);
        }
    });

    it("split across providers: still nets to zero", () => {
        const { debit, credits, fees } = charge("j2", 0.2, [{ provider_id: "a", share: 0.5 }, { provider_id: "b", share: 0.5 }]);
        expect(fees.length).toBe(credits.length);
        expect(ledgerNet([debit, ...credits, ...fees])).toBe(0);
    });

    it("mirrors the source status, and posts nothing without a fee or a platform provider", () => {
        expect(platformFeeFor({ id: "x", kind: "paid", fee_usd: 0.01, status: "pending" }, PLATFORM).status).toBe("pending");
        expect(platformFeeFor({ id: "x", kind: "reservation", fee_usd: 1, status: "confirmed" }, PLATFORM).metadata.source_kind).toBe("reservation");
        expect(platformFeeFor({ id: "x", kind: "paid", fee_usd: 0, status: "confirmed" }, PLATFORM)).toBeNull();
        expect(platformFeeFor({ id: "x", kind: "subsidy", fee_usd: 0, status: "confirmed" }, PLATFORM)).toBeNull();
        expect(platformFeeFor({ id: "x", kind: "paid", fee_usd: 0.01, status: "confirmed" }, null)).toBeNull();
    });

    it("the platform account's own spend nets to zero once its fees are credited back", () => {
        // The admin account pays for 3 jobs that other nodes served.
        const rows = ["a", "b", "c"].flatMap((id) => { const r = charge(id, 0.001, [{ provider_id: "other", share: 1 }]); return [r.debit, ...r.fees]; });
        const nodeRows = ["a", "b", "c"].flatMap((id) => charge(id, 0.001, [{ provider_id: "other", share: 1 }]).credits);
        const platformBalance = ledgerNet(rows);           // debits + fee credits
        const nodeEarned = ledgerNet(nodeRows);
        expect(platformBalance).toBeCloseTo(-nodeEarned, 8);  // only what nodes earned left the account
    });
});

describe("revenue reads platform_fee rows, never fee_usd twice", () => {
    it("summariseFees: ledger rows when present, fee_usd only as a fallback", () => {
        const credits = [{ kind: "paid", status: "confirmed", fee_usd: 0.05, gross_usd: 1, amount_usd: 0.95 }];
        const fees = [{ kind: "platform_fee", status: "confirmed", amount_usd: 0.05 }];
        expect(summariseFees(credits, fees).fees_usd).toBe(0.05);
        expect(summariseFees(credits).fees_usd).toBe(0.05);
        expect(summariseFees(credits, [...fees, { kind: "platform_fee", status: "void", amount_usd: 9 }]).fees_usd).toBe(0.05);
    });

    it("network money: house fees are neither network earnings nor counted twice", () => {
        const earnings = [
            { kind: "paid", status: "confirmed", provider_id: "n", amount_usd: 0.95, fee_usd: 0.05, gross_usd: 1 },
            { kind: "platform_fee", status: "confirmed", provider_id: PLATFORM, amount_usd: 0.05, fee_usd: 0, gross_usd: 0.05 }
        ];
        const m = summariseNetworkMoney(earnings, []);
        expect(m.earned_usd).toBe(0.95);
        expect(m.fees_usd).toBe(0.05);
        expect(m.credits).toBe(1);
        expect(summariseBalance(earnings.slice(1), [])).toMatchObject({ platform_fee_usd: 0.05, jobs_credited: 0, available_usd: 0.05 });
        expect(EARNINGS_SERIES_EXCLUDED_KINDS).toContain("platform_fee");
        expect(EARNING_KIND_LABELS.platform_fee).toBe("house fee (platform)");
    });

    it("summariseRevenue: interactive fees from the ledger; internal and batch not double counted", () => {
        const r = summariseRevenue({
            jobs: [{ id: "cp", provider_id: "n", payment_offer: 1 }],
            earnings: [{ kind: "paid", job_id: "cp", fee_usd: 0.05, amount_usd: 0.95, status: "confirmed" }],
            batchCharges: [{ job_id: "bj", cost_usd: 1, provider_usd: 0.95, email: "x@y.z" }],
            platformFees: [
                { job_id: "cp", source_kind: "paid", amount_usd: 0.05, status: "confirmed" },
                { job_id: "bj", source_kind: "paid", amount_usd: 0.05, status: "confirmed" },
                { job_id: "i1", source_kind: "paid", amount_usd: 0.02, status: "confirmed" },
                { job_id: "i2", source_kind: "paid", amount_usd: 0.03, status: "confirmed", internal: true },
                { job_id: "i3", source_kind: "paid", amount_usd: 9, status: "void" }
            ],
            config
        });
        expect(r.platform_fee.paid_jobs_usd).toBe(0.05);
        expect(r.batches.platform_fee_usd).toBe(0.05);
        expect(r.platform_fee.interactive_usd).toBe(0.02);
        expect(r.excluded.internal_interactive_fee_usd).toBe(0.03);
        expect(r.platform_fee.ledger_credited_usd).toBe(0.15);
        expect(r.platform_fee_usd).toBe(0.12); // 0.05 coinpay + 0.05 batch + 0.02 interactive
    });
});

describe("migration 20261118170000_platform_fee_ledger.sql", () => {
    const sql = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase/migrations/20261118170000_platform_fee_ledger.sql"), "utf8");
    it("posts by trigger, once per source credit, and backfills idempotently", () => {
        expect(sql).toMatch(/create trigger provider_earnings_platform_fee/);
        expect(sql).toMatch(/on conflict \(source_earning_id\) where kind = 'platform_fee' do update/);
        expect(sql).toMatch(/create unique index if not exists provider_earnings_platform_fee_key/);
        expect(sql).toMatch(/kind in \('paid', 'reservation'\) and fee_usd > 0/);
    });
});
