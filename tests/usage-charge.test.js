import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
    USAGE_KINDS,
    MAX_USAGE_CHARGE_USD,
    validateUsageCharge,
    usageJobId,
    usageKindLabel,
    chargeUsage
} from "../apps/web/lib/billing/usage.js";
import { chargeIdemKey } from "../apps/web/lib/billing/interactive.js";
import { commissionRowFor } from "../apps/web/lib/referrals/core.js";
import { platformFeeFor } from "../apps/web/lib/earnings/core.js";

/**
 * POST /api/v1/billing/usage-charge: c0mpute bills a streamer's balance for
 * relay bytes (c0mpute Live) and the node that relayed is credited.
 *
 * What must hold, since this moves money on a trusted client's word:
 *   - only a trusted key, acting for a named subject, gets in;
 *   - a charge the balance cannot cover moves nothing at all;
 *   - a repeated idem_key returns the original result and moves nothing;
 *   - the node keeps 95%, the house 5%, written as the same 'paid'
 *     provider_earnings row a billed chat writes, so the house fee and the
 *     referral commission (5% of that fee) follow from the existing triggers.
 *
 * The route runs against the real data layer (c0mputeProviderId,
 * creditProvidersFromCharge) over an in-memory Supabase; billing_charge_exact
 * is mirrored below and tested for real in supabase/tests/usage_charge_test.sql.
 */

const TRUSTED_KEY = "ifc_" + "a".repeat(48);
const PEER = "12D3KooWLxQZFJhZer1mywvnti85VeMTCRhJveunvYExsdNT3kCN";
const PROVIDER = `c0mpute:${PEER}`;
const SUBJECT = "cp-sub-streamer";
const USER = "user-streamer";

const db = {};

function reset() {
    for (const k of Object.keys(db)) delete db[k];
    Object.assign(db, {
        coinpay_identities: [{ coinpay_sub: SUBJECT, user_id: USER }],
        providers: [],
        jobs: [],
        provider_earnings: [],
        settings: [],
        billing_ledger: [],
        accounts: { [USER]: { balance: 10_000_000, held: 0 } },
        failOnce: {}
    });
}

/** billing_charge_exact (20261122200000_usage_charge.sql), without earnings. */
function chargeExact({ p_user_id, p_idem, p_cost_micro }) {
    const acct = (db.accounts[p_user_id] ??= { balance: 0, held: 0 });
    const avail = Math.max(acct.balance - acct.held, 0);
    const prior = db.billing_ledger.find((r) => r.idem_key === p_idem);
    if (prior) {
        return { charged: false, reason: "already_charged", charged_micro: prior.amount_micro, user_id: prior.user_id, spendable_micro: avail };
    }
    if (avail < p_cost_micro) {
        return { charged: false, reason: "insufficient_balance", charged_micro: 0, user_id: p_user_id, spendable_micro: avail };
    }
    db.billing_ledger.push({ user_id: p_user_id, kind: "charge", amount_micro: p_cost_micro, idem_key: p_idem });
    acct.balance -= p_cost_micro;
    return { charged: true, charged_micro: p_cost_micro, user_id: p_user_id, spendable_micro: avail - p_cost_micro };
}

function fakeSupabase() {
    return {
        async rpc(name, args) {
            if (name !== "billing_charge_exact") return { data: null, error: { message: `no rpc ${name}` } };
            return { data: chargeExact(args), error: null };
        },
        from(table) {
            const rows = db[table] ?? (db[table] = []);
            const q = { op: "select", filters: [], payload: null, opts: {} };
            const match = (r) => q.filters.every(([c, v]) => r[c] === v);
            const run = () => {
                const key = `${table}.${q.op}`;
                if (db.failOnce[key]) {
                    delete db.failOnce[key];
                    return { data: null, error: { message: `${key} failed` } };
                }
                if (q.op === "select") return { data: rows.filter(match), error: null };
                if (q.op === "update") {
                    for (const r of rows.filter(match)) Object.assign(r, q.payload);
                    return { data: null, error: null };
                }
                const made = [];
                const keys = q.op === "upsert" ? String(q.opts.onConflict ?? "id").split(",") : [];
                for (const r of [].concat(q.payload)) {
                    if (q.op === "upsert" && rows.some((x) => keys.every((k) => x[k] === r[k]))) continue; // ignoreDuplicates
                    // providers.node_id is unique: a second insert for one node loses.
                    if (table === "providers" && rows.some((x) => x.node_id === r.node_id)) {
                        return { data: null, error: { message: "duplicate key value violates unique constraint" } };
                    }
                    const row = { id: randomUUID(), ...r };
                    rows.push(row);
                    made.push(row);
                }
                return { data: made, error: null };
            };
            const one = async () => {
                const r = run();
                return { data: r.data?.[0] ?? null, error: r.error };
            };
            const chain = {
                select() { return chain; },
                eq(c, v) { q.filters.push([c, v]); return chain; },
                insert(p) { q.op = "insert"; q.payload = p; return chain; },
                update(p) { q.op = "update"; q.payload = p; return chain; },
                upsert(p, opts = {}) { q.op = "upsert"; q.payload = p; q.opts = opts; return chain; },
                maybeSingle: one,
                single: one,
                then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
            };
            return chain;
        }
    };
}

vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fakeSupabase() }));

process.env.INFERNET_TRUSTED_CLIENT_KEYS = `c0mpute:${createHash("sha256").update(TRUSTED_KEY).digest("hex")}`;
const { POST } = await import("@/app/api/v1/billing/usage-charge/route");

const AUTH = { authorization: `Bearer ${TRUSTED_KEY}`, "x-infernet-billed-subject": SUBJECT };

function body(over = {}) {
    return { idem_key: "live:stream-1:node-1:0001", kind: "live.relay", cost_usd: 1, provider: PROVIDER, ...over };
}

async function post(payload = body(), headers = AUTH) {
    const res = await POST(new Request("https://infernetprotocol.com/api/v1/billing/usage-charge", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof payload === "string" ? payload : JSON.stringify(payload)
    }));
    return { status: res.status, json: await res.json() };
}

/** Everything that would show money having moved. */
function moved() {
    return {
        balance: db.accounts[USER]?.balance,
        ledger: db.billing_ledger.length,
        jobs: db.jobs.length,
        credits: db.provider_earnings.length
    };
}

beforeEach(reset);

describe("validateUsageCharge", () => {
    it("accepts the contract body", () => {
        const v = validateUsageCharge(body({ cost_usd: 0.0123456, meta: { stream: "s1", bytes: 1234 } }));
        expect(v).toMatchObject({ ok: true, value: { idemKey: "live:stream-1:node-1:0001", kind: "live.relay", costMicro: 12346, provider: PROVIDER, peerId: PEER, meta: { stream: "s1", bytes: 1234 } } });
    });

    it("rejects an unknown kind", () => {
        expect(USAGE_KINDS).toEqual(["live.relay", "board.meeting"]);
        for (const kind of ["live.transcode", "inference", "", null, undefined, 7]) {
            expect(validateUsageCharge(body({ kind }))).toMatchObject({ ok: false, status: 400 });
        }
    });

    it("rejects non-finite, non-positive, non-number and oversized amounts", () => {
        for (const cost_usd of [NaN, Infinity, -Infinity, 0, -0.01, "1", "0.01", null, undefined, {}, [1], true]) {
            expect(validateUsageCharge(body({ cost_usd }))).toMatchObject({ ok: false, status: 400 });
        }
        expect(validateUsageCharge(body({ cost_usd: MAX_USAGE_CHARGE_USD }))).toMatchObject({ ok: true, value: { costMicro: 50_000_000 } });
        expect(validateUsageCharge(body({ cost_usd: MAX_USAGE_CHARGE_USD + 0.000001 }))).toMatchObject({ ok: false, status: 400 });
        // Under a micro-dollar there is nothing the ledger can record.
        expect(validateUsageCharge(body({ cost_usd: 0.0000001 }))).toMatchObject({ ok: false, status: 400 });
        expect(validateUsageCharge(body({ cost_usd: 0.000001 }))).toMatchObject({ ok: true, value: { costMicro: 1 } });
    });

    it("only credits a c0mpute node, named by a real peer id", () => {
        for (const provider of ["", PEER, "c0mpute:", "c0mpute:short", `infernet:${PEER}`, `c0mpute:${PEER} `, `c0mpute:${PEER}/x`, null, 5]) {
            expect(validateUsageCharge(body({ provider }))).toMatchObject({ ok: false, status: 400 });
        }
    });

    it("needs an idem key, and bounds it and meta", () => {
        for (const idem_key of ["", "   ", "has space", "x".repeat(201), null, 5]) {
            expect(validateUsageCharge(body({ idem_key }))).toMatchObject({ ok: false, status: 400 });
        }
        expect(validateUsageCharge(body({ meta: "text" })).ok).toBe(false);
        expect(validateUsageCharge(body({ meta: [1] })).ok).toBe(false);
        expect(validateUsageCharge(body({ meta: { big: "x".repeat(3000) } })).ok).toBe(false);
        expect(validateUsageCharge(null).ok).toBe(false);
        expect(validateUsageCharge([]).ok).toBe(false);
    });
});

describe("usageJobId", () => {
    it("is a stable UUID per client and idem key", () => {
        const id = usageJobId("c0mpute", "k1");
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(usageJobId("c0mpute", "k1")).toBe(id);
        expect(usageJobId("c0mpute", "k2")).not.toBe(id);
        // Two trusted clients cannot collide on a key.
        expect(usageJobId("other-app", "k1")).not.toBe(id);
    });
});

describe("auth", () => {
    it("401s with no credentials", async () => {
        const r = await post(body(), {});
        expect(r.status).toBe(401);
        expect(moved()).toMatchObject({ ledger: 0, credits: 0 });
    });

    it("403s for a key that is not a trusted client", async () => {
        // Right shape, never registered.
        expect((await post(body(), { authorization: `Bearer ifc_${"b".repeat(48)}`, "x-infernet-billed-subject": SUBJECT })).status).toBe(403);
        // A person's own API key must not be able to name a subject and a payee.
        expect((await post(body(), { authorization: `Bearer ik_live_${"a".repeat(43)}`, "x-infernet-billed-subject": SUBJECT })).status).toBe(403);
        expect(moved()).toMatchObject({ balance: 10_000_000, ledger: 0, jobs: 0, credits: 0 });
    });

    it("400s for a trusted client that names nobody", async () => {
        const r = await post(body(), { authorization: `Bearer ${TRUSTED_KEY}` });
        expect(r.status).toBe(400);
        expect(moved()).toMatchObject({ ledger: 0, credits: 0 });
    });

    it("400s on a bad body before touching anything", async () => {
        expect((await post("{not json")).status).toBe(400);
        expect((await post(body({ kind: "nope" }))).status).toBe(400);
        expect((await post(body({ cost_usd: 51 }))).status).toBe(400);
        expect((await post(body({ cost_usd: -1 }))).status).toBe(400);
        expect((await post(body({ cost_usd: "1" }))).status).toBe(400);
        expect(moved()).toMatchObject({ balance: 10_000_000, ledger: 0, jobs: 0, credits: 0 });
        expect(db.providers).toHaveLength(0);
    });
});

describe("a charge the payer cannot cover", () => {
    it("answers no_account for a subject with no Infernet account, and moves nothing", async () => {
        db.coinpay_identities = [];
        const r = await post();
        expect(r.status).toBe(200);
        expect(r.json.data).toEqual({ charged: false, reason: "no_account", balance_usd: 0 });
        expect(moved()).toMatchObject({ ledger: 0, jobs: 0, credits: 0 });
        expect(db.providers).toHaveLength(0);
    });

    it("answers insufficient_balance and moves nothing: no partial charge, no job, no credit", async () => {
        db.accounts[USER] = { balance: 400_000, held: 0 };
        const r = await post(body({ cost_usd: 0.5 }));
        expect(r.status).toBe(200);
        expect(r.json.data).toEqual({ charged: false, reason: "insufficient_balance", balance_usd: 0.4 });
        expect(moved()).toEqual({ balance: 400_000, ledger: 0, jobs: 0, credits: 0 });
    });

    it("never takes funds a batch is holding", async () => {
        db.accounts[USER] = { balance: 1_000_000, held: 800_000 };
        const r = await post(body({ cost_usd: 0.5 }));
        expect(r.json.data).toEqual({ charged: false, reason: "insufficient_balance", balance_usd: 0.2 });
        expect(moved()).toEqual({ balance: 1_000_000, ledger: 0, jobs: 0, credits: 0 });
    });

    it("lets the same key through once the balance is there", async () => {
        db.accounts[USER] = { balance: 0, held: 0 };
        expect((await post()).json.data.charged).toBe(false);
        db.accounts[USER].balance = 2_000_000;
        const r = await post();
        expect(r.json.data).toEqual({ charged: true, cost_usd: 1, operator_usd: 0.95, fee_usd: 0.05, balance_usd: 1 });
        expect(moved()).toEqual({ balance: 1_000_000, ledger: 1, jobs: 1, credits: 1 });
    });
});

describe("fee split", () => {
    it("charges the payer in full, pays the node 95% and the house 5%", async () => {
        const r = await post(body({ meta: { stream: "s1", bytes: 107374182400 } }));
        expect(r.status).toBe(200);
        expect(r.json.data).toEqual({ charged: true, cost_usd: 1, operator_usd: 0.95, fee_usd: 0.05, balance_usd: 9 });
        expect(db.accounts[USER].balance).toBe(9_000_000);

        const jobId = usageJobId("c0mpute", "live:stream-1:node-1:0001");
        // The same ledger key a billed chat job uses.
        expect(db.billing_ledger).toEqual([{ user_id: USER, kind: "charge", amount_micro: 1_000_000, idem_key: chargeIdemKey(jobId) }]);

        // The node is the same provider row its inference is settled on.
        expect(db.providers).toHaveLength(1);
        expect(db.providers[0]).toMatchObject({ node_id: PROVIDER, status: "c0mpute", is_public: false });

        // One 'paid' credit, like a billed chat, labelled by kind.
        expect(db.provider_earnings).toHaveLength(1);
        expect(db.provider_earnings[0]).toMatchObject({
            job_id: jobId,
            provider_id: db.providers[0].id,
            kind: "paid",
            status: "confirmed",
            model_name: "live.relay",
            gross_usd: "1.000000",
            fee_usd: "0.050000",
            amount_usd: "0.950000",
            metadata: { source: "usage", usage_kind: "live.relay", house_fee_pct: 5, charge_micro: 1_000_000, billed_user_id: USER }
        });

        expect(db.jobs).toHaveLength(1);
        expect(db.jobs[0]).toMatchObject({
            id: jobId,
            type: "usage",
            title: "usage:live.relay",
            status: "completed",
            model_name: "live.relay",
            provider_id: db.providers[0].id,
            billed_user_id: USER,
            input_spec: { billing: "usage_charge", kind: "live.relay", client: "c0mpute", provider: PROVIDER, cost_micro: 1_000_000, meta: { stream: "s1", bytes: 107374182400 } }
        });
        expect(usageKindLabel(db.jobs[0].title)).toBe("Live relay");
        expect(usageKindLabel("chat:qwen2.5:7b")).toBeNull();
    });

    it("rounds the fee down, so the node never gets less than 95%", async () => {
        // 19 micro at 5% is 0.95 micro of fee: the house takes 0, the node 19.
        const r = await post(body({ cost_usd: 0.000019 }));
        expect(r.json.data).toMatchObject({ charged: true, cost_usd: 0.000019, operator_usd: 0.000019, fee_usd: 0 });
        // One GB at $0.01: 10000 micro, 500 to the house.
        const gb = await post(body({ idem_key: "gb", cost_usd: 0.01 }));
        expect(gb.json.data).toMatchObject({ charged: true, cost_usd: 0.01, operator_usd: 0.0095, fee_usd: 0.0005 });
    });

    it("uses the house fee from the interactive billing settings", async () => {
        db.settings = [{ key: "interactive_billing", value: { house_fee_pct: 10 } }];
        const r = await post();
        expect(r.json.data).toMatchObject({ operator_usd: 0.9, fee_usd: 0.1 });
    });

    it("credits each node its own charge on one provider row", async () => {
        await post(body({ idem_key: "a" }));
        await post(body({ idem_key: "b", cost_usd: 2 }));
        expect(db.providers).toHaveLength(1);
        expect(db.provider_earnings.map((e) => e.amount_usd)).toEqual(["0.950000", "1.900000"]);
        expect(db.accounts[USER].balance).toBe(7_000_000);
    });
});

describe("idempotency", () => {
    it("returns the original result for a repeated idem_key and moves nothing", async () => {
        const first = await post();
        const before = moved();
        const again = await post();
        expect(again.status).toBe(200);
        expect(again.json.data).toEqual(first.json.data);
        expect(moved()).toEqual(before);
        expect(before).toEqual({ balance: 9_000_000, ledger: 1, jobs: 1, credits: 1 });
    });

    it("reports the split the charge was made at, even after the fee changes", async () => {
        const first = await post();
        db.settings = [{ key: "interactive_billing", value: { house_fee_pct: 50 } }];
        const again = await post();
        expect(again.json.data).toEqual(first.json.data);
        expect(db.provider_earnings).toHaveLength(1);
    });

    it("409s when the key comes back as a different charge", async () => {
        await post();
        const before = moved();
        const other = "12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo";
        for (const over of [{ cost_usd: 2 }, { provider: `c0mpute:${other}` }]) {
            const r = await post(body(over));
            expect(r.status).toBe(409);
            expect(r.json.code).toBe("idem_key_reused");
        }
        // Another person naming the same key is not charged either.
        db.coinpay_identities.push({ coinpay_sub: "cp-other", user_id: "user-other" });
        db.accounts["user-other"] = { balance: 5_000_000, held: 0 };
        const r = await post(body(), { ...AUTH, "x-infernet-billed-subject": "cp-other" });
        expect(r.status).toBe(409);
        expect(db.accounts["user-other"].balance).toBe(5_000_000);
        expect(moved()).toEqual(before);
    });

    it("finishes the node credit on a retry after a failure, charging once", async () => {
        db.failOnce["provider_earnings.upsert"] = true;
        const failed = await post();
        expect(failed.status).toBe(500);
        // The payer was charged; the node is not credited yet.
        expect(moved()).toMatchObject({ balance: 9_000_000, ledger: 1, credits: 0 });

        const retry = await post();
        expect(retry.status).toBe(200);
        expect(retry.json.data).toEqual({ charged: true, cost_usd: 1, operator_usd: 0.95, fee_usd: 0.05, balance_usd: 9 });
        expect(moved()).toEqual({ balance: 9_000_000, ledger: 1, jobs: 1, credits: 1 });
    });

    it("two calls racing the same key charge and credit once", async () => {
        const [a, b] = await Promise.all([post(), post()]);
        expect(a.json.data).toEqual(b.json.data);
        expect(moved()).toEqual({ balance: 9_000_000, ledger: 1, jobs: 1, credits: 1 });
    });
});

describe("referral commission and house fee", () => {
    const referrer = "user-referrer";
    const attribution = {
        node_key: PROVIDER,
        referrer_user_id: referrer,
        arm: "lifetime",
        attributed_at: "2020-01-01T00:00:00.000Z",
        first_settled_at: null,
        node_owner_user_id: null
    };

    it("pays the referrer 5% of the house fee, out of the fee and never out of the node's share", async () => {
        const r = await post(body({ cost_usd: 10 }));
        const credit = db.provider_earnings[0];
        // What the provider_earnings triggers post for this row (pure mirrors).
        const commission = commissionRowFor({ earning: credit, attribution, config: null });
        expect(commission).toMatchObject({
            source_earning_id: credit.id,
            referrer_user_id: referrer,
            node_key: PROVIDER,
            job_id: credit.job_id,
            fee_usd: 0.5,
            commission_pct: 5,
            amount_usd: 0.025,
            status: "confirmed"
        });
        expect(commission.amount_usd).toBeLessThanOrEqual(r.json.data.fee_usd);
        // The node's share is untouched by the commission.
        expect(r.json.data.operator_usd).toBe(9.5);
        expect(r.json.data.operator_usd + r.json.data.fee_usd).toBe(r.json.data.cost_usd);

        // And the fee itself is credited to the platform, as for inference.
        expect(platformFeeFor(credit, "platform-provider")).toMatchObject({ kind: "platform_fee", amount_usd: 0.5, status: "confirmed" });
    });

    it("pays no commission when the referrer is the one paying", async () => {
        await post();
        const credit = db.provider_earnings[0];
        expect(commissionRowFor({ earning: credit, attribution: { ...attribution, referrer_user_id: USER }, config: null })).toBeNull();
    });

    it("pays no commission on a charge too small to carry a fee", async () => {
        await post(body({ cost_usd: 0.000019 }));
        expect(commissionRowFor({ earning: db.provider_earnings[0], attribution, config: null })).toBeNull();
    });
});

describe("chargeUsage", () => {
    it("503s when the node's provider row cannot be opened, before charging", async () => {
        const calls = [];
        const store = {
            providerId: async () => null,
            charge: async () => { calls.push("charge"); return {}; }
        };
        const input = validateUsageCharge(body()).value;
        await expect(chargeUsage({ input, userId: USER, client: "c0mpute", store, feePct: 5 })).rejects.toMatchObject({ status: 503 });
        expect(calls).toEqual([]);
    });
});

describe("board.meeting: a house charge no node earns", () => {
    const boardBody = (over = {}) => ({ idem_key: "board:mtg-1", kind: "board.meeting", cost_usd: 0.84, provider: "house", ...over });

    it("validates: board.meeting must name the house, live.relay must name a node", () => {
        expect(USAGE_KINDS).toContain("board.meeting");
        expect(validateUsageCharge(boardBody()).value).toMatchObject({ kind: "board.meeting", provider: "house", peerId: null, costMicro: 840000 });
        expect(validateUsageCharge(boardBody({ provider: `c0mpute:${PEER}` })).ok).toBe(false);
        expect(validateUsageCharge(body({ provider: "house" })).ok).toBe(false);
        expect(usageKindLabel("usage:board.meeting")).toBe("Board meeting");
    });

    function houseStore(chargeResult) {
        const calls = [];
        const jobs = new Map();
        return {
            calls,
            providerId: async () => { calls.push("providerId"); return "should-not-be-used"; },
            charge: async (a) => { calls.push(["charge", a.costMicro]); return chargeResult(a); },
            job: async (id) => jobs.get(id) ?? null,
            ensureJob: async (row) => { calls.push(["ensureJob", row.provider_id, row.model_name]); if (!jobs.has(row.id)) jobs.set(row.id, row); },
            credit: async () => { calls.push("credit"); },
            earning: async () => { calls.push("earning"); return null; }
        };
    }

    it("charges the balance, records the job with no provider, credits nobody", async () => {
        const store = houseStore(() => ({ charged: true, charged_micro: 840000, spendable_micro: 9160000 }));
        const input = validateUsageCharge(boardBody()).value;
        const out = await chargeUsage({ input, userId: USER, client: "c0mpute", store, feePct: 5 });
        expect(out).toEqual({ charged: true, cost_usd: 0.84, operator_usd: 0, fee_usd: 0.84, balance_usd: 9.16 });
        expect(store.calls).toEqual([["charge", 840000], ["ensureJob", null, "board.meeting"]]);
    });

    it("a short balance moves nothing; a replay of the same key is not a second charge", async () => {
        const short = houseStore(() => ({ charged: false, spendable_micro: 100000 }));
        const input = validateUsageCharge(boardBody()).value;
        expect(await chargeUsage({ input, userId: USER, client: "c0mpute", store: short, feePct: 5 })).toEqual({ charged: false, reason: "insufficient_balance", balance_usd: 0.1 });
        expect(short.calls).toEqual([["charge", 840000]]);

        let first = true;
        const store = houseStore(() => {
            const r = first ? { charged: true, charged_micro: 840000, spendable_micro: 1 } : { charged: false, reason: "already_charged", charged_micro: 840000, user_id: USER, spendable_micro: 1 };
            first = false;
            return r;
        });
        await chargeUsage({ input, userId: USER, client: "c0mpute", store, feePct: 5 });
        expect((await chargeUsage({ input, userId: USER, client: "c0mpute", store, feePct: 5 })).charged).toBe(true);
        const other = validateUsageCharge(boardBody({ cost_usd: 2 })).value;
        await expect(chargeUsage({ input: other, userId: USER, client: "c0mpute", store, feePct: 5 })).rejects.toMatchObject({ status: 409 });
        expect(store.calls.filter((c) => c === "credit")).toEqual([]);
    });
});
