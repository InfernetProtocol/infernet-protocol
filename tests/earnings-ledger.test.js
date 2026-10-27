import { beforeEach, describe, expect, it, vi } from "vitest";

// A small in-memory PostgREST stand-in: enough of the supabase-js builder
// (select/eq/in/neq/order/range/limit/maybeSingle/single/insert/update/upsert)
// to run the ledger + payout flow end to end without a database.
const db = { tables: {} };

function table(name) {
    db.tables[name] ??= [];
    return db.tables[name];
}

let seq = 0;
function builder(name) {
    const filters = [];
    let op = "select";
    let payload = null;
    let opts = {};
    let single = null;
    let rangeFrom = null;
    let rangeTo = null;
    let limitN = null;
    const match = (row) => filters.every((f) => f(row));
    const run = () => {
        const rows = table(name);
        let data;
        let error = null;
        if (op === "insert" || op === "upsert") {
            const list = Array.isArray(payload) ? payload : [payload];
            data = [];
            for (const r of list) {
                if (op === "upsert" && opts.onConflict) {
                    const keys = opts.onConflict.split(",");
                    const hit = rows.find((x) => keys.every((k) => x[k] === r[k]));
                    if (hit) {
                        if (!opts.ignoreDuplicates) Object.assign(hit, r);
                        continue;
                    }
                }
                if (name === "payout_requests" && ["requested", "approved", "sending"].includes(r.status ?? "requested") &&
                    rows.some((x) => x.provider_id === r.provider_id && ["requested", "approved", "sending"].includes(x.status))) {
                    error = { message: "duplicate key value violates unique constraint \"payout_requests_one_open\"" };
                    break;
                }
                const row = { id: `row-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), status: name === "payout_requests" ? "requested" : undefined, ...r };
                rows.push(row);
                data.push(row);
            }
        } else if (op === "update") {
            data = rows.filter(match);
            for (const r of data) Object.assign(r, payload);
        } else {
            data = rows.filter(match);
            if (rangeFrom != null) data = data.slice(rangeFrom, rangeTo + 1);
            if (limitN != null) data = data.slice(0, limitN);
        }
        data = data.map((r) => ({ ...r }));
        if (single === "maybe") return { data: data[0] ?? null, error };
        if (single === "one") return { data: data[0] ?? null, error: error ?? (data[0] ? null : { message: "no rows" }) };
        return { data, error };
    };
    const q = {
        select() { return q; },
        eq(c, v) { filters.push((r) => r[c] === v); return q; },
        neq(c, v) { filters.push((r) => r[c] !== v); return q; },
        in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
        order() { return q; },
        limit(n) { limitN = n; return q; },
        range(a, b) { rangeFrom = a; rangeTo = b; return q; },
        insert(p) { op = "insert"; payload = p; return q; },
        upsert(p, o = {}) { op = "upsert"; payload = p; opts = o; return q; },
        update(p) { op = "update"; payload = p; return q; },
        maybeSingle() { single = "maybe"; return Promise.resolve(run()); },
        single() { single = "one"; return Promise.resolve(run()); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
    };
    return q;
}

const fake = {
    from: (n) => builder(n),
    rpc: async (name, { new_rate }) => {
        let n = 0;
        for (const r of table("provider_earnings")) {
            if (r.kind === "subsidy" && r.status === "pending_approval") {
                r.rate_per_1k_usd = new_rate;
                r.amount_usd = r.gross_usd = Math.round((r.output_tokens / 1000) * new_rate * 1e8) / 1e8;
                n += 1;
            }
        }
        return { data: n, error: null };
    },
    auth: { admin: { getUserById: async () => ({ data: { user: { email: "op@example.com" } } }) } } };
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fake }));

const earnings = await import("@/lib/data/earnings");

beforeEach(() => {
    db.tables = {
        providers: [{ id: "p1", public_key: "pk1", name: "saha55" }],
        pubkey_links: [{ pubkey: "pk1", user_id: "u1" }],
        provider_payouts: [],
        settings: []
    };
});

async function credit(jobId, over = {}) {
    return earnings.creditCompletedJob({
        job: { id: jobId, provider_id: "p1", payment_offer: 0, ...over },
        result: { token_count: 1000 }
    });
}

describe("earnings ledger", () => {
    it("credits a free job once, however often completion is retried", async () => {
        for (let i = 0; i < 3; i++) await credit("j1");
        expect(table("provider_earnings")).toHaveLength(1);
        expect(table("provider_earnings")[0]).toMatchObject({ kind: "subsidy", status: "pending_approval" });
    });

    it("accrues without a payout address, but withdrawal needs one", async () => {
        await earnings.updateEarningsConfig({ subsidy_approved: true, subsidy_per_1k_output_usd: 3, min_payout_usd: 1 });
        await credit("j1");
        const { balance } = await earnings.getEarningsForNode({ pubkey: "pk1" });
        expect(balance.confirmed_usd).toBe(3);
        await expect(earnings.requestPayoutForNode({ pubkey: "pk1" })).rejects.toThrow(/payout address/);
    });

    it("approving the subsidy confirms credits already pending approval", async () => {
        await credit("j1");
        await credit("j2");
        const out = await earnings.updateEarningsConfig({ subsidy_approved: true });
        expect(out.confirmed_subsidy_credits).toBe(2);
        expect(table("provider_earnings").every((r) => r.status === "confirmed")).toBe(true);
    });

    it("a rate change re-prices credits pending approval, not confirmed ones", async () => {
        await credit("j1");
        const out = await earnings.updateEarningsConfig({ subsidy_per_1k_output_usd: 0.01 });
        expect(out.repriced_subsidy_credits).toBe(1);
        expect(table("provider_earnings")[0]).toMatchObject({ amount_usd: 0.01, rate_per_1k_usd: 0.01 });
        await earnings.updateEarningsConfig({ subsidy_approved: true });
        await earnings.updateEarningsConfig({ subsidy_per_1k_output_usd: 1 });
        expect(table("provider_earnings")[0].amount_usd).toBe(0.01);
    });

    it("a paid job's credit is confirmed when the client's payment confirms", async () => {
        await credit("j9", { payment_offer: 4 });
        expect(table("provider_earnings")[0]).toMatchObject({ kind: "paid", status: "pending", amount_usd: 3.6, fee_usd: 0.4 });
        expect(await earnings.confirmPaidJobCredits("j9")).toBe(1);
        expect(table("provider_earnings")[0].status).toBe("confirmed");
    });
});

describe("payout requests", () => {
    beforeEach(async () => {
        db.tables.provider_payouts = [{ provider_id: "p1", coin: "USDC", network: "polygon", address: "0xabc", is_default: true, created_at: "2026-10-01" }];
        await earnings.updateEarningsConfig({ subsidy_approved: true, subsidy_per_1k_output_usd: 3, min_payout_usd: 5 });
        await credit("j1");
        await credit("j2");
    });

    it("queues a request for the available balance and allows only one open", async () => {
        const { request } = await earnings.requestPayoutForNode({ pubkey: "pk1" });
        expect(request).toMatchObject({ amount_usd: 6, coin: "USDC", network: "polygon", address: "0xabc", status: "requested" });
        await expect(earnings.requestPayoutForNode({ pubkey: "pk1" })).rejects.toThrow(/already waiting/);
        const { balance } = await earnings.getEarningsForNode({ pubkey: "pk1" });
        expect(balance).toMatchObject({ requested_usd: 6, available_usd: 0 });
    });

    it("refuses below the minimum", async () => {
        await expect(earnings.requestPayoutForNode({ pubkey: "pk1", amountUsd: 2 })).rejects.toThrow(/minimum/);
    });

    it("approve sends through the gateway exactly once and records the tx", async () => {
        const { request } = await earnings.requestPayoutForNode({ pubkey: "pk1" });
        const send = vi.fn(async () => ({ outcome: "sent", txHash: "0xtx", payoutId: "cp1" }));
        const out = await earnings.approvePayoutRequest(request.id, { actor: "admin-token", send });
        expect(out.outcome).toBe("sent");
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toMatchObject({ recipientWallet: "0xabc", amountUsd: 6, cryptocurrency: "USDC_POL", recipientEmail: "op@example.com" });
        await expect(earnings.approvePayoutRequest(request.id, { send })).rejects.toThrow(/sent, not requested/);
        expect(send).toHaveBeenCalledTimes(1);
        const { balance } = await earnings.getEarningsForNode({ pubkey: "pk1" });
        expect(balance).toMatchObject({ paid_usd: 6, available_usd: 0 });
        expect(table("payment_transactions")[0]).toMatchObject({ direction: "outbound", tx_hash: "0xtx" });
    });

    it("an unknown gateway outcome stays 'sending' (never re-sendable) until resolved", async () => {
        const { request } = await earnings.requestPayoutForNode({ pubkey: "pk1" });
        const out = await earnings.approvePayoutRequest(request.id, { send: async () => ({ outcome: "unknown", error: "timeout" }) });
        expect(out.request.status).toBe("sending");
        await expect(earnings.requestPayoutForNode({ pubkey: "pk1" })).rejects.toThrow(/already waiting/);
        await earnings.resolveSendingPayout(request.id, { actor: "a", failed: true });
        const { balance } = await earnings.getEarningsForNode({ pubkey: "pk1" });
        expect(balance.available_usd).toBe(6);
    });

    it("a failed send returns the amount to the balance", async () => {
        const { request } = await earnings.requestPayoutForNode({ pubkey: "pk1" });
        const out = await earnings.approvePayoutRequest(request.id, { send: async () => ({ outcome: "failed", error: "Insufficient balance" }) });
        expect(out.request).toMatchObject({ status: "failed", error: "Insufficient balance" });
        const { balance } = await earnings.getEarningsForNode({ pubkey: "pk1" });
        expect(balance.available_usd).toBe(6);
    });

    it("reject frees the balance", async () => {
        const { request } = await earnings.requestPayoutForNode({ pubkey: "pk1" });
        await earnings.rejectPayoutRequest(request.id, { reason: "test" });
        const { balance } = await earnings.getEarningsForNode({ pubkey: "pk1" });
        expect(balance.available_usd).toBe(6);
    });
});
