import { describe, it, expect } from "vitest";
import { summariseLeaderboard, leaderboardToken } from "../apps/web/lib/leaderboard/core.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();
const KEY = "ifc_test_key";
const PEER = "12D3KooWAbCdEfGhJkLmNpQrStUvWxYz123456789abcdeFGH";

const rows = {
    providers: [
        { id: "p-c0", node_id: `c0mpute:${PEER}`, public_key: "pk-alice" },
        { id: "p-bob", node_id: "bob-box", public_key: "pk-bob" },
        { id: "p-hidden", node_id: "secret", public_key: "pk-carol", is_public: false },
        { id: "p-arch", node_id: "gone", public_key: "pk-carol", archived_at: ago(5), archived_is_public: false }
    ],
    links: [
        { pubkey: "pk-alice", user_id: "u-alice", role: "provider" },
        { pubkey: "pk-bob", user_id: "u-bob", role: "provider" },
        { pubkey: "pk-carol", user_id: "u-carol", role: "provider" }
    ],
    identities: [{ user_id: "u-alice", coinpay_sub: "sub-alice" }],
    earnings: [
        { id: "e1", provider_id: "p-c0", kind: "paid", status: "confirmed", amount_usd: 1, output_tokens: 100, model_name: "m7b", billed: "u-x", earned_at: ago(1) },
        { id: "e2", provider_id: "p-c0", kind: "paid", status: "pending", amount_usd: 2, output_tokens: 50, model_name: "m7b", billed: "u-y", earned_at: ago(100) },
        { id: "e3", provider_id: "p-bob", kind: "paid", status: "confirmed", amount_usd: 0.5, output_tokens: 10, model_name: "m1b", billed: "u-x", earned_at: ago(2) },
        { id: "e4", provider_id: "p-bob", kind: "paid", status: "void", amount_usd: 99, model_name: "m1b", earned_at: ago(2) },
        { id: "e5", provider_id: "p-bob", kind: "subsidy", status: "confirmed", amount_usd: 50, output_tokens: 5, model_name: "m1b", earned_at: ago(2) },
        { id: "e6", provider_id: "p-hidden", kind: "paid", status: "confirmed", amount_usd: 9, model_name: "m7b", earned_at: ago(2) },
        { id: "e7", provider_id: "p-arch", kind: "paid", status: "confirmed", amount_usd: 9, model_name: "m7b", earned_at: ago(2) },
        { id: "e8", provider_id: "house", kind: "platform_fee", status: "confirmed", amount_usd: 0.1, earned_at: ago(1) },
        { id: "e9", provider_id: "p-bob", kind: "spent_on_compute", status: "confirmed", amount_usd: -3, earned_at: ago(1) }
    ],
    charges: [
        { id: 1, user_id: "u-x", amount_micro: 1_500_000, created_at: ago(1) },
        { id: 2, user_id: "u-x", amount_micro: 500_000, created_at: ago(200) },
        { id: 3, user_id: "u-alice", amount_micro: 250_000, created_at: ago(3) },
        { id: 4, user_id: "u-admin", amount_micro: 9_000_000, created_at: ago(1) }
    ],
    commissions: [
        { id: "c1", referrer_user_id: "u-alice", status: "confirmed", amount_usd: 0.002, earned_at: ago(1) },
        { id: "c2", referrer_user_id: "u-bob", status: "void", amount_usd: 5, earned_at: ago(1) }
    ],
    attributions: [{ node_key: "n1", referrer_user_id: "u-bob", attributed_at: ago(48) }]
};

const s = summariseLeaderboard(rows, { key: KEY, now: NOW, adminIds: ["U-ADMIN"] });
const json = JSON.stringify(s);

describe("summariseLeaderboard", () => {
    it("never emits raw ids, subs, pubkeys or provider node names", () => {
        for (const raw of ["u-alice", "u-bob", "u-carol", "u-x", "u-admin", "sub-alice", "pk-alice", "p-c0", "p-bob", "bob-box", "secret", PEER]) {
            expect(json).not.toContain(raw);
        }
    });

    it("tokens are keyed by the caller: the caller can recompute them, another key cannot", () => {
        const alice = s.windows.all.spenders.find((r) => r.who === leaderboardToken(KEY, "sub:sub-alice"));
        expect(alice?.spent_usd).toBeCloseTo(0.25, 8);
        const other = summariseLeaderboard(rows, { key: "ifc_other", now: NOW });
        expect(other.windows.all.spenders.map((r) => r.who)).not.toContain(alice.who);
        // An account with no CoinPay link is keyed by its user id, still hashed.
        expect(s.windows.all.spenders[0].who).toBe(leaderboardToken(KEY, "user:u-x"));
    });

    it("operators: net credits only, hidden providers left out, c0mpute nodes keep the board id", () => {
        const all = s.windows.all.providers;
        expect(all.map((p) => p.earned_usd)).toEqual([3, 0.5]);
        expect(all[0].c0mpute_node).toBe(PEER.slice(-8));
        expect(all[0].owner).toBe(leaderboardToken(KEY, "sub:sub-alice"));
        expect(all[1].c0mpute_node).toBeUndefined();
        expect(s.windows["24h"].providers.map((p) => p.earned_usd)).toEqual([1, 0.5]);
    });

    it("customers exclude house accounts and window by time", () => {
        expect(s.windows.all.spenders.map((r) => r.spent_usd)).toEqual([2, 0.25]);
        expect(s.windows["24h"].spenders.map((r) => r.spent_usd)).toEqual([1.5, 0.25]);
        expect(s.windows.all.totals.spenders).toBe(2);
    });

    it("models count served jobs (subsidy included, void and hidden excluded) with distinct users", () => {
        const m = Object.fromEntries(s.windows.all.models.map((r) => [r.model, r]));
        expect(m.m7b).toEqual({ model: "m7b", jobs: 2, output_tokens: 150, users: 2 });
        expect(m.m1b).toEqual({ model: "m1b", jobs: 2, output_tokens: 15, users: 1 });
    });

    it("referrers: live commissions plus nodes referred", () => {
        const r = s.windows.all.referrers;
        expect(r[0]).toEqual({ who: leaderboardToken(KEY, "sub:sub-alice"), commissions_usd: 0.002, nodes: 0 });
        expect(r[1].nodes).toBe(1);
        expect(r[1].commissions_usd).toBe(0);
        expect(s.windows["24h"].referrers.length).toBe(1);
    });

    it("refuses to run without a key", () => {
        expect(() => summariseLeaderboard(rows, {})).toThrow();
    });
});
