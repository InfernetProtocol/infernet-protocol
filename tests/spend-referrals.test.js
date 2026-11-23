import { describe, it, expect } from "vitest";
import {
    resolveReferralConfig,
    DEFAULT_REFERRAL_CONFIG,
    HOUSE_HANDLES,
    payerOf,
    spendCommissionFor,
    spendCommissionRowFor,
    withinSpendWindow,
    userAttributionRefusal,
    commissionRowFor,
    summariseCommissions,
    summariseResults,
    referralTerms
} from "../apps/web/lib/referrals/core.js";
import { summariseLeaderboard } from "../apps/web/lib/leaderboard/core.js";

// Spend referrals (2026-11-23): referrers earn a share of the HOUSE FEE on
// what the people they referred spend. These mirror the SQL trigger
// post_spend_referral_commission (migration 20261123120000_spend_referrals.sql),
// which was also run against the production schema in a rolled-back
// transaction.

const REFERRER = "11111111-1111-4111-8111-111111111111";
const PERSON = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const HOUSE = "66666666-6666-4666-8666-666666666666";
const NODE_OWNER = "22222222-2222-4222-8222-222222222222";

const attribution = (extra = {}) => ({
    referred_user_id: PERSON,
    referrer_user_id: REFERRER,
    attributed_at: "2026-11-23T00:00:00.000Z",
    ...extra
});

function credit(extra = {}) {
    return {
        id: "e1",
        kind: "paid",
        provider_id: "p1",
        job_id: "j1",
        gross_usd: 0.02,
        fee_usd: 0.001,
        amount_usd: 0.019,
        status: "confirmed",
        earned_at: "2026-11-24T00:00:00.000Z",
        confirmed_at: "2026-11-24T00:00:00.000Z",
        metadata: { source: "interactive", billed_user_id: PERSON },
        ...extra
    };
}

describe("spend referral config", () => {
    it("defaults: 50% of the house fee, no expiry, on, no house accounts", () => {
        const c = resolveReferralConfig(null);
        expect(c.spend_enabled).toBe(true);
        expect(c.spend_commission_pct_of_house_fee).toBe(50);
        expect(c.spend_term_months).toBe(0);
        expect(c.house_user_ids).toEqual([]);
        expect(DEFAULT_REFERRAL_CONFIG.spend_commission_pct_of_house_fee).toBe(50);
    });
    it("reads the settings row and rejects nonsense", () => {
        const c = resolveReferralConfig({ spend_commission_pct_of_house_fee: 30, spend_term_months: 12, house_user_ids: [HOUSE, 7] });
        expect(c.spend_commission_pct_of_house_fee).toBe(30);
        expect(c.spend_term_months).toBe(12);
        expect(c.house_user_ids).toEqual([HOUSE]);
        expect(resolveReferralConfig({ spend_commission_pct_of_house_fee: 150 }).spend_commission_pct_of_house_fee).toBe(50);
        expect(resolveReferralConfig({ spend_term_months: -1 }).spend_term_months).toBe(0);
        expect(resolveReferralConfig({ spend_enabled: false }).spend_enabled).toBe(false);
    });
    it("leaves the node program's numbers alone", () => {
        const c = resolveReferralConfig({ commission_pct_of_house_fee: 5, term_months_12m: 12 });
        expect(c.commission_pct_of_house_fee).toBe(5);
        expect(c.term_months_12m).toBe(12);
    });
});

describe("spend commission math", () => {
    it("is a share of the fee actually collected, never of gross", () => {
        // $0.02 spent, $0.001 house fee -> $0.0005, i.e. 2.5% of spend at a 5% fee
        const row = spendCommissionRowFor({ earning: credit(), attribution: attribution(), config: {} });
        expect(row.amount_usd).toBe(0.0005);
        expect(row.fee_usd).toBe(0.001);
        expect(row.kind).toBe("spend");
        expect(row.referred_user_id).toBe(PERSON);
        expect(row.node_key).toBeNull();
        expect(row.arm).toBeNull();
        // same gross, smaller fee -> smaller commission: the fee drives it
        expect(spendCommissionRowFor({ earning: credit({ fee_usd: 0.0002 }), attribution: attribution(), config: {} }).amount_usd).toBe(0.0001);
    });
    it("never more than the fee, and never more than what the node commission leaves", () => {
        expect(spendCommissionFor({ feeUsd: 0.01, pct: 100 })).toBe(0.01);
        expect(spendCommissionFor({ feeUsd: 0.01, pct: 100, otherCommissionsUsd: 0.0005 })).toBe(0.0095);
        expect(spendCommissionFor({ feeUsd: 0.01, pct: 50, otherCommissionsUsd: 0.0005 })).toBe(0.005);
        expect(spendCommissionFor({ feeUsd: 0.01, pct: 50, otherCommissionsUsd: 0.02 })).toBe(0);
    });
    it("no fee, free tier, subsidy or void earns nothing", () => {
        const a = attribution();
        expect(spendCommissionRowFor({ earning: credit({ fee_usd: 0 }), attribution: a, config: {} })).toBeNull();
        expect(spendCommissionRowFor({ earning: credit({ kind: "subsidy" }), attribution: a, config: {} })).toBeNull();
        expect(spendCommissionRowFor({ earning: credit({ status: "void" }), attribution: a, config: {} })).toBeNull();
        expect(spendCommissionRowFor({ earning: credit({ kind: "platform_fee" }), attribution: a, config: {} })).toBeNull();
    });
    it("only the referred person's spend counts", () => {
        expect(spendCommissionRowFor({ earning: credit({ metadata: { billed_user_id: OTHER } }), attribution: attribution(), config: {} })).toBeNull();
        expect(spendCommissionRowFor({ earning: credit({ metadata: {} }), attribution: attribution(), config: {} })).toBeNull();
    });
    it("spend before the attribution earns nothing (no retroactive referrals)", () => {
        expect(spendCommissionRowFor({ earning: credit({ earned_at: "2026-11-22T00:00:00.000Z" }), attribution: attribution(), config: {} })).toBeNull();
    });
    it("house referrers earn nothing", () => {
        const row = spendCommissionRowFor({
            earning: credit(),
            attribution: attribution({ referrer_user_id: HOUSE }),
            config: { house_user_ids: [HOUSE] }
        });
        expect(row).toBeNull();
    });
    it("a shared payout wallet is a self-referral", () => {
        const row = spendCommissionRowFor({
            earning: credit(),
            attribution: attribution(),
            config: {},
            wallets: { referrer: "0xABC0000000000000000000000000000000000001", payer: ["0xabc0000000000000000000000000000000000001"] }
        });
        expect(row).toBeNull();
    });
    it("optional window in months from attribution; 0 = forever", () => {
        expect(withinSpendWindow({ attributedAt: "2026-01-01T00:00:00Z", earnedAt: "2036-01-01T00:00:00Z", months: 0 })).toBe(true);
        expect(withinSpendWindow({ attributedAt: "2026-01-01T00:00:00Z", earnedAt: "2026-06-30T00:00:00Z", months: 6 })).toBe(true);
        expect(withinSpendWindow({ attributedAt: "2026-01-01T00:00:00Z", earnedAt: "2026-07-01T00:00:00Z", months: 6 })).toBe(false);
        const late = credit({ earned_at: "2027-12-01T00:00:00.000Z" });
        expect(spendCommissionRowFor({ earning: late, attribution: attribution(), config: { spend_term_months: 12 } })).toBeNull();
        expect(spendCommissionRowFor({ earning: late, attribution: attribution(), config: {} })).not.toBeNull();
    });
    it("switched off -> nothing", () => {
        expect(spendCommissionRowFor({ earning: credit(), attribution: attribution(), config: { spend_enabled: false } })).toBeNull();
        expect(spendCommissionRowFor({ earning: credit(), attribution: attribution(), config: { enabled: false } })).toBeNull();
    });
    it("resolves the payer like the trigger: billed user, batch owner, job payer", () => {
        expect(payerOf(credit())).toBe(PERSON);
        expect(payerOf(credit({ metadata: { source: "prepaid_batch", batch_id: "b1" } }), { batchOwner: PERSON })).toBe(PERSON);
        expect(payerOf(credit({ metadata: {} }), { jobPayer: PERSON })).toBe(PERSON);
        expect(payerOf(credit({ metadata: { billed_user_id: "c0mpute:u_abc" } }))).toBeNull();
        expect(payerOf(credit({ kind: "reservation", metadata: { source: "reservation_order" } }))).toBeNull();
    });
});

describe("no double count", () => {
    it("one credit = at most one node and one spend commission, summing to at most the fee", () => {
        const e = credit({ fee_usd: 0.01, gross_usd: 0.2, amount_usd: 0.19 });
        const node = commissionRowFor({
            earning: e,
            attribution: { node_key: "c0mpute:12D3KooWnode", referrer_user_id: OTHER, arm: "lifetime", attributed_at: "2026-01-01T00:00:00Z", node_owner_user_id: NODE_OWNER },
            config: {}
        });
        const spend = spendCommissionRowFor({ earning: e, attribution: attribution(), config: {}, otherCommissionsUsd: node.amount_usd });
        expect(node.amount_usd).toBe(0.0005);
        expect(spend.amount_usd).toBe(0.005);
        expect(node.amount_usd + spend.amount_usd).toBeLessThanOrEqual(e.fee_usd);
    });
    it("summaries split node and spend and the A/B results ignore spend rows", () => {
        const commissions = [
            { kind: "node", arm: "12m", referrer_user_id: REFERRER, amount_usd: 0.0005, fee_usd: 0.01, status: "confirmed" },
            { kind: "spend", arm: null, referrer_user_id: REFERRER, amount_usd: 0.005, fee_usd: 0.01, status: "confirmed" },
            { kind: "spend", arm: null, referrer_user_id: REFERRER, amount_usd: 0.001, fee_usd: 0.002, status: "pending" }
        ];
        const b = summariseCommissions(commissions, []);
        expect(b.confirmed_usd).toBe(0.0055);
        expect(b.available_usd).toBe(0.0055);
        expect(b.by_kind.node.confirmed_usd).toBe(0.0005);
        expect(b.by_kind.spend.confirmed_usd).toBe(0.005);
        expect(b.by_kind.spend.pending_usd).toBe(0.001);
        const r = summariseResults({ codes: [{ user_id: REFERRER, arm: "12m" }], commissions });
        expect(r.arms.find((a) => a.arm === "12m").commissions_accrued_usd).toBe(0.0005);
    });
    it("rows from before the migration (no kind) are node commissions", () => {
        const b = summariseCommissions([{ referrer_user_id: REFERRER, amount_usd: 0.1, status: "confirmed" }], []);
        expect(b.by_kind.node.confirmed_usd).toBe(0.1);
        expect(b.by_kind.spend.confirmed_usd).toBe(0);
    });
});

describe("attributing a person", () => {
    const base = {
        referrerUserId: REFERRER,
        referredUserId: PERSON,
        code: "abcd2345",
        config: {},
        accountCreatedAt: new Date(Date.now() - 60_000).toISOString()
    };
    it("a new, never-charged account with a real code is attributed", () => {
        expect(userAttributionRefusal(base)).toBeNull();
    });
    it("self-referral is blocked", () => {
        expect(userAttributionRefusal({ ...base, referredUserId: REFERRER })).toBe("same_account");
        expect(userAttributionRefusal({ ...base, referrerWallets: ["0xAA"], referredWallets: ["0xaa"] })).toBe("same_payout_wallet");
    });
    it("the house handle and house accounts are skipped", () => {
        expect(HOUSE_HANDLES).toContain("profullstack");
        expect(userAttributionRefusal({ ...base, code: "profullstack" })).toBe("house_handle");
        expect(userAttributionRefusal({ ...base, referrerUserId: HOUSE, config: { house_user_ids: [HOUSE] } })).toBe("house_account");
    });
    it("first touch only: no change once set, no retroactive add on an old or charged account", () => {
        expect(userAttributionRefusal({ ...base, alreadyAttributed: true })).toBe("already_attributed");
        expect(userAttributionRefusal({ ...base, accountCreatedAt: "2026-01-01T00:00:00Z" })).toBe("not_new");
        expect(userAttributionRefusal({ ...base, accountCreatedAt: null })).toBe("not_new");
        expect(userAttributionRefusal({ ...base, hasCharges: true })).toBe("not_new");
    });
    it("unknown codes and a switched-off program refuse", () => {
        expect(userAttributionRefusal({ ...base, referrerUserId: null })).toBe("unknown_code");
        expect(userAttributionRefusal({ ...base, config: { spend_enabled: false } })).toBe("disabled");
    });
});

describe("terms + leaderboard", () => {
    it("terms state 50% of the 5% fee = 2.5% of spend, from config", () => {
        const t = referralTerms({ config: {}, earnings: { house_fee_pct: 5, min_payout_usd: 0.01, auto_approve_max_usd: 100 } });
        expect(t.spend).toEqual({ enabled: true, commission_pct_of_house_fee: 50, effective_pct_of_spend: 2.5, term_months: null });
        expect(t.commission_pct_of_house_fee).toBe(5);
        expect(t.effective_pct_of_node_revenue).toBe(0.25);
    });
    it("the affiliates board counts node and spend commissions and referred people", () => {
        const now = Date.parse("2026-11-24T12:00:00Z");
        const out = summariseLeaderboard({
            commissions: [
                { referrer_user_id: REFERRER, kind: "node", status: "confirmed", amount_usd: 0.001, earned_at: "2026-11-24T00:00:00Z" },
                { referrer_user_id: REFERRER, kind: "spend", status: "confirmed", amount_usd: 0.005, earned_at: "2026-11-24T00:00:00Z" }
            ],
            attributions: [{ referrer_user_id: REFERRER, attributed_at: "2026-11-24T00:00:00Z" }],
            people: [{ referrer_user_id: REFERRER, attributed_at: "2026-11-24T00:00:00Z" }]
        }, { key: "k", now });
        const r = out.windows.all.referrers[0];
        expect(r.commissions_usd).toBe(0.006);
        expect(r.nodes).toBe(1);
        expect(r.people).toBe(1);
        expect(r.who).not.toContain(REFERRER);
    });
});
