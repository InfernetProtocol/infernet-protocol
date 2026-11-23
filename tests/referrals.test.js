import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
    commissionFor,
    withinTerm,
    addMonths,
    commissionRowFor,
    applyCreditsToLedger,
    selfReferralReason,
    assignArm,
    generateReferralCode,
    normalizeReferralCode,
    ipPrefix,
    ipPrefixHash,
    verifyC0mputeClaim,
    c0mputeClaimMessage,
    ed25519KeyFromPeerId,
    summariseCommissions,
    summariseResults,
    referralTerms,
    resolveReferralConfig
} from "../apps/web/lib/referrals/core.js";
import { TOOLS } from "../apps/cli/commands/mcp.js";
import { referralCodeToSend } from "../apps/cli/commands/register.js";

const REFERRER = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "22222222-2222-4222-8222-222222222222";
const BUYER = "33333333-3333-4333-8333-333333333333";

function attribution(arm, extra = {}) {
    return {
        node_key: "c0mpute:12D3KooWnode",
        referrer_user_id: REFERRER,
        arm,
        attributed_at: "2026-01-01T00:00:00.000Z",
        first_settled_at: null,
        node_owner_user_id: OPERATOR,
        ...extra
    };
}

let seq = 0;
function credit(earnedAt, extra = {}) {
    seq += 1;
    return {
        id: `e${seq}`,
        job_id: `j${seq}`,
        provider_id: "p1",
        kind: "paid",
        status: "confirmed",
        gross_usd: 0.02,
        fee_usd: 0.001,
        amount_usd: 0.019,
        earned_at: earnedAt,
        confirmed_at: earnedAt,
        metadata: { billed_user_id: BUYER },
        ...extra
    };
}

describe("accrual math", () => {
    it("is 5% of the house fee", () => {
        // c0mpute: 5% house fee on a $0.02 job = $0.001 fee -> $0.00005 commission
        expect(commissionFor({ feeUsd: 0.001, pct: 5 })).toBeCloseTo(0.00005, 10);
        // Infernet at a 2% fee: $1.00 job -> $0.02 fee -> $0.001 (0.1% of revenue)
        expect(commissionFor({ feeUsd: 0.02, pct: 5 })).toBeCloseTo(0.001, 10);
    });
    it("is never more than the house earned, and nothing on a fee of 0", () => {
        expect(commissionFor({ feeUsd: 0.5, pct: 500 })).toBe(0.5);
        expect(commissionFor({ feeUsd: 0, pct: 5 })).toBe(0);
        expect(commissionFor({ feeUsd: -1, pct: 5 })).toBe(0);
        expect(commissionFor({ feeUsd: 0.001, pct: 0 })).toBe(0);
    });
    it("rounds to 8 decimals like numeric(18,8)", () => {
        expect(commissionFor({ feeUsd: 0.00000033, pct: 5 })).toBe(0.00000002);
    });
    it("reads the rate from one config value, with safe fallbacks", () => {
        expect(resolveReferralConfig({ commission_pct_of_house_fee: 7 }).commission_pct_of_house_fee).toBe(7);
        expect(resolveReferralConfig({ commission_pct_of_house_fee: "nope" }).commission_pct_of_house_fee).toBe(5);
        expect(resolveReferralConfig({ commission_pct_of_house_fee: 150 }).commission_pct_of_house_fee).toBe(5);
        expect(resolveReferralConfig(null)).toMatchObject({ enabled: true, commission_pct_of_house_fee: 5, term_months_12m: 12 });
    });
    it("free / subsidy / unpaid jobs earn nothing", () => {
        const a = attribution("lifetime");
        expect(commissionRowFor({ earning: credit("2026-02-01T00:00:00Z", { kind: "subsidy", fee_usd: 0 }), attribution: a })).toBeNull();
        expect(commissionRowFor({ earning: credit("2026-02-01T00:00:00Z", { fee_usd: 0 }), attribution: a })).toBeNull();
        expect(commissionRowFor({ earning: credit("2026-02-01T00:00:00Z", { status: "void" }), attribution: a })).toBeNull();
        expect(commissionRowFor({ earning: credit("2026-02-01T00:00:00Z", { kind: "platform_fee" }), attribution: a })).toBeNull();
    });
    it("a commission row mirrors its source and records the rate", () => {
        const row = commissionRowFor({ earning: credit("2026-02-01T00:00:00Z", { status: "pending" }), attribution: attribution("12m") });
        expect(row).toMatchObject({ status: "pending", arm: "12m", commission_pct: 5, fee_usd: 0.001, amount_usd: 0.00005, referrer_user_id: REFERRER });
    });
});

describe("term cutoff per arm", () => {
    it("12m stops 12 calendar months after the first settled job", () => {
        const first = "2026-03-15T10:00:00.000Z";
        expect(withinTerm({ arm: "12m", firstSettledAt: first, earnedAt: "2027-03-15T09:59:59.999Z" })).toBe(true);
        expect(withinTerm({ arm: "12m", firstSettledAt: first, earnedAt: "2027-03-15T10:00:00.000Z" })).toBe(false);
        expect(withinTerm({ arm: "12m", firstSettledAt: first, earnedAt: "2028-01-01T00:00:00.000Z" })).toBe(false);
    });
    it("lifetime never stops", () => {
        expect(withinTerm({ arm: "lifetime", firstSettledAt: "2026-01-01T00:00:00Z", earnedAt: "2040-01-01T00:00:00Z" })).toBe(true);
    });
    it("adds months like Postgres (clamps the day)", () => {
        expect(addMonths("2026-01-31T00:00:00Z", 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
        expect(addMonths("2028-02-29T12:00:00Z", 12).toISOString()).toBe("2029-02-28T12:00:00.000Z");
    });
    it("the term starts at the node's first fee-bearing job, not at attribution", () => {
        const ctx = { attribution: attribution("12m"), config: null };
        const jobs = [
            credit("2026-06-01T00:00:00.000Z"),
            credit("2027-05-31T23:59:59.000Z"),
            credit("2027-06-01T00:00:00.000Z"),
            credit("2030-01-01T00:00:00.000Z")
        ];
        const { ledger, attribution: a } = applyCreditsToLedger([], jobs, ctx);
        expect(a.first_settled_at).toBe("2026-06-01T00:00:00.000Z");
        expect(ledger.map((r) => r.source_earning_id)).toEqual([jobs[0].id, jobs[1].id]);
        const life = applyCreditsToLedger([], jobs, { attribution: attribution("lifetime") });
        expect(life.ledger).toHaveLength(4);
    });
    it("a job the referrer paid for still starts the term", () => {
        const jobs = [
            credit("2026-01-10T00:00:00.000Z", { metadata: { billed_user_id: REFERRER } }),
            credit("2027-01-10T00:00:00.000Z")
        ];
        const { ledger, attribution: a } = applyCreditsToLedger([], jobs, { attribution: attribution("12m") });
        expect(a.first_settled_at).toBe("2026-01-10T00:00:00.000Z");
        expect(ledger).toHaveLength(0);
    });
    it("jobs before the attribution earn nothing", () => {
        expect(commissionRowFor({ earning: credit("2025-12-31T23:00:00Z"), attribution: attribution("lifetime") })).toBeNull();
    });
});

describe("self-referral", () => {
    const referrer = { user_id: REFERRER, payout_address: "0xAbC0000000000000000000000000000000000001", created_ip24: ipPrefixHash("203.0.113.9") };
    it("blocks the same account", () => {
        expect(selfReferralReason({ referrer, node: { owner_user_id: REFERRER } })).toBe("same_account");
    });
    it("blocks a shared payout wallet (case-insensitive), including the referrer's own nodes' wallets", () => {
        expect(selfReferralReason({ referrer, node: { payout_addresses: ["0xabc0000000000000000000000000000000000001"] } })).toBe("same_payout_wallet");
        expect(selfReferralReason({ referrer: { ...referrer, provider_addresses: ["bc1qxyz"] }, node: { payout_addresses: ["BC1QXYZ"] } })).toBe("same_payout_wallet");
    });
    it("blocks the same /24", () => {
        expect(selfReferralReason({ referrer, node: { ip24: ipPrefixHash("203.0.113.200") } })).toBe("same_network");
        expect(selfReferralReason({ referrer: { ...referrer, provider_ip24s: [ipPrefixHash("198.51.100.4")] }, node: { ip24: ipPrefixHash("198.51.100.77") } })).toBe("same_network");
    });
    it("allows a stranger on another network", () => {
        expect(selfReferralReason({ referrer, node: { owner_user_id: OPERATOR, payout_addresses: ["0xdef"], ip24: ipPrefixHash("192.0.2.1") } })).toBeNull();
    });
    it("rechecks at accrual: the referrer buying from the node, or now owning it, earns nothing", () => {
        const a = attribution("lifetime");
        expect(commissionRowFor({ earning: credit("2026-02-01T00:00:00Z", { metadata: { billed_user_id: REFERRER } }), attribution: a })).toBeNull();
        expect(commissionRowFor({ earning: credit("2026-02-01T00:00:00Z"), attribution: a, nodeOwnerUserId: REFERRER })).toBeNull();
        expect(commissionRowFor({ earning: credit("2026-02-01T00:00:00Z"), attribution: a, referrerPayoutAddress: "0xAA", nodePayoutAddresses: ["0xaa"] })).toBeNull();
        expect(commissionRowFor({ earning: credit("2026-02-01T00:00:00Z", { metadata: { billed_user_id: OPERATOR } }), attribution: a })).toBeNull();
    });
    it("keeps only a hash of the network prefix", () => {
        expect(ipPrefix("203.0.113.9")).toBe("203.0.113.0/24");
        expect(ipPrefix("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
        expect(ipPrefix("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
        expect(ipPrefixHash("203.0.113.9")).toMatch(/^[0-9a-f]{64}$/);
        expect(ipPrefixHash("not an ip")).toBeNull();
    });
});

describe("idempotent accrual on settle retries", () => {
    it("the same credit applied twice yields one commission", () => {
        const ctx = { attribution: attribution("lifetime") };
        const c = credit("2026-02-01T00:00:00Z", { status: "pending" });
        const once = applyCreditsToLedger([], [c], ctx);
        const twice = applyCreditsToLedger(once.ledger, [c, c], { attribution: once.attribution });
        expect(twice.ledger).toHaveLength(1);
        expect(twice.ledger[0].amount_usd).toBe(once.ledger[0].amount_usd);
    });
    it("a status change on the source moves the commission, never duplicates it", () => {
        const ctx = { attribution: attribution("lifetime") };
        const c = credit("2026-02-01T00:00:00Z", { status: "pending", confirmed_at: null });
        const first = applyCreditsToLedger([], [c], ctx);
        const confirmed = applyCreditsToLedger(first.ledger, [{ ...c, status: "confirmed", confirmed_at: "2026-02-01T00:05:00Z" }], first);
        expect(confirmed.ledger).toHaveLength(1);
        expect(confirmed.ledger[0].status).toBe("confirmed");
        const voided = applyCreditsToLedger(confirmed.ledger, [{ ...c, status: "void" }], confirmed);
        expect(voided.ledger[0].status).toBe("void");
        expect(summariseCommissions(voided.ledger, []).confirmed_usd).toBe(0);
    });
    it("the commission keeps the rate it was earned at when the config changes", () => {
        const c = credit("2026-02-01T00:00:00Z");
        const first = applyCreditsToLedger([], [c], { attribution: attribution("lifetime"), config: { commission_pct_of_house_fee: 5 } });
        const again = applyCreditsToLedger(first.ledger, [c], { attribution: first.attribution, config: { commission_pct_of_house_fee: 50 } });
        expect(again.ledger[0].commission_pct).toBe(5);
        expect(again.ledger[0].amount_usd).toBeCloseTo(0.00005, 10);
    });
});

describe("arms, codes and terms", () => {
    it("assigns 12m / lifetime 50/50", () => {
        expect(assignArm(() => 0.1)).toBe("12m");
        expect(assignArm(() => 0.9)).toBe("lifetime");
        let n12 = 0;
        for (let i = 0; i < 4000; i += 1) if (assignArm() === "12m") n12 += 1;
        expect(n12).toBeGreaterThan(1800);
        expect(n12).toBeLessThan(2200);
    });
    it("codes are 8 unambiguous characters and normalize from a pasted link", () => {
        const code = generateReferralCode();
        expect(code).toMatch(/^[2-9a-hjkmnp-z]{8}$/);
        expect(normalizeReferralCode(` https://c0mpute.com/r/${code.toUpperCase()}?x=1 `)).toBe(code);
        expect(normalizeReferralCode("../etc")).toBeNull();
    });
    it("terms come from live config and say the reader's term only", () => {
        const t = referralTerms({ config: null, earnings: { house_fee_pct: 5, min_payout_usd: 0.01, auto_approve_max_usd: 100 }, arm: "12m" });
        expect(t).toMatchObject({ commission_pct_of_house_fee: 5, house_fee_pct: 5, effective_pct_of_node_revenue: 0.25, min_payout_usd: 0.01 });
        expect(t.term.months).toBe(12);
        expect(referralTerms({ config: null, earnings: { house_fee_pct: 2 } }).effective_pct_of_node_revenue).toBe(0.1);
    });
});

// base58btc encode for building a test peer id.
function b58(buf) {
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = BigInt(`0x${Buffer.from(buf).toString("hex")}`);
    let s = "";
    while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
    for (const b of buf) { if (b !== 0) break; s = `1${s}`; }
    return s;
}

function c0mputeNode() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const peerId = b58(Buffer.concat([Buffer.from([0x00, 36, 0x08, 0x01, 0x12, 0x20]), raw]));
    return { peerId, privateKey, raw };
}

describe("c0mpute node claims", () => {
    it("accepts a claim signed by the key behind the peer id", () => {
        const node = c0mputeNode();
        expect(node.peerId.startsWith("12D3KooW")).toBe(true);
        expect(Buffer.compare(ed25519KeyFromPeerId(node.peerId), node.raw)).toBe(0);
        const ts = Math.floor(Date.now() / 1000);
        const sig = sign(null, Buffer.from(c0mputeClaimMessage({ peerId: node.peerId, code: "abcd2345", ts })), node.privateKey).toString("base64");
        expect(verifyC0mputeClaim({ peerId: node.peerId, code: "abcd2345", ts, sig })).toEqual({ ok: true });
    });
    it("refuses another node's key, a changed code, and a stale claim", () => {
        const a = c0mputeNode();
        const b = c0mputeNode();
        const ts = Math.floor(Date.now() / 1000);
        const sig = sign(null, Buffer.from(c0mputeClaimMessage({ peerId: a.peerId, code: "abcd2345", ts })), b.privateKey).toString("base64");
        expect(verifyC0mputeClaim({ peerId: a.peerId, code: "abcd2345", ts, sig }).ok).toBe(false);
        const good = sign(null, Buffer.from(c0mputeClaimMessage({ peerId: a.peerId, code: "abcd2345", ts })), a.privateKey).toString("base64");
        expect(verifyC0mputeClaim({ peerId: a.peerId, code: "zzzz2345", ts, sig: good }).ok).toBe(false);
        const old = ts - 3600;
        const oldSig = sign(null, Buffer.from(c0mputeClaimMessage({ peerId: a.peerId, code: "abcd2345", ts: old })), a.privateKey).toString("base64");
        expect(verifyC0mputeClaim({ peerId: a.peerId, code: "abcd2345", ts: old, sig: oldSig }).ok).toBe(false);
        expect(verifyC0mputeClaim({ peerId: "QmNotEd25519", code: "abcd2345", ts, sig: good }).ok).toBe(false);
    });
});

describe("results view", () => {
    it("summarises per arm", () => {
        const now = Date.parse("2026-11-22T00:00:00Z");
        const r = summariseResults({
            now,
            codes: [{ user_id: "a", arm: "12m" }, { user_id: "b", arm: "lifetime" }, { user_id: "c", arm: "lifetime" }],
            attributions: [
                { node_key: "n1", referrer_user_id: "a", arm: "12m", provider_id: "p1", first_settled_at: "2026-11-01T00:00:00Z" },
                { node_key: "n2", referrer_user_id: "b", arm: "lifetime", provider_id: "p2", first_settled_at: null }
            ],
            credits: [
                { provider_id: "p1", kind: "paid", status: "confirmed", gross_usd: 1, fee_usd: 0.05, earned_at: "2026-11-21T00:00:00Z" },
                { provider_id: "p1", kind: "subsidy", status: "confirmed", gross_usd: 9, fee_usd: 0, earned_at: "2026-11-21T00:00:00Z" },
                { provider_id: "p1", kind: "paid", status: "void", gross_usd: 9, fee_usd: 1, earned_at: "2026-11-21T00:00:00Z" }
            ],
            commissions: [{ referrer_user_id: "a", arm: "12m", amount_usd: 0.0025, status: "confirmed" }],
            payouts: [{ referrer_user_id: "a", amount_usd: 0.0025, status: "sent" }]
        });
        const [m12, life] = r.arms;
        expect(m12).toMatchObject({ arm: "12m", referrers: 1, referred_nodes: 1, nodes_with_paid_jobs: 1, active_nodes: 1, referred_revenue_usd: 1, house_fee_usd: 0.05, commissions_accrued_usd: 0.0025, commissions_paid_usd: 0.0025 });
        expect(life).toMatchObject({ arm: "lifetime", referrers: 2, referred_nodes: 1, active_nodes: 0, referred_revenue_usd: 0 });
    });
});

describe("CLI + MCP", () => {
    it("exposes referral_link and referral_stats as MCP tools", () => {
        const names = TOOLS.map((t) => t.name);
        expect(names).toContain("referral_link");
        expect(names).toContain("referral_stats");
    });
    it("register sends --ref, else INFERNET_REFERRAL, else a saved unanswered code", () => {
        const args = (flags) => ({ get: (k) => flags[k] });
        expect(referralCodeToSend(args({ ref: "abcd2345" }), {}, {})).toBe("abcd2345");
        expect(referralCodeToSend(args({}), {}, { INFERNET_REFERRAL: "envcode1" })).toBe("envcode1");
        expect(referralCodeToSend(args({}), { referral: { code: "saved123" } }, {})).toBe("saved123");
        expect(referralCodeToSend(args({}), { referral: { code: "saved123", attributed: false } }, {})).toBeNull();
    });
});
