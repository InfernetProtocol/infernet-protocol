import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
    bucketEarningsHourly,
    parseC0mputeNodeIds,
    c0mputeNodeOf,
    ownPayerIds,
    resolveEarningsSince,
    countsTowardEarningsSeries,
    hourStartIso,
    EARNINGS_SERIES_MAX_DAYS
} from "@/lib/earnings/core";

const NOW = Date.parse("2026-11-18T12:30:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("resolveEarningsSince", () => {
    it("defaults to 24 hours ago", () => {
        expect(resolveEarningsSince(null, NOW)).toBe("2026-11-17T12:30:00.000Z");
        expect(resolveEarningsSince("not a date", NOW)).toBe("2026-11-17T12:30:00.000Z");
    });

    it("keeps a valid since inside the window", () => {
        expect(resolveEarningsSince("2026-11-10T00:00:00Z", NOW)).toBe("2026-11-10T00:00:00.000Z");
    });

    it("clamps to at most 31 days back, and never into the future", () => {
        const floor = new Date(NOW - EARNINGS_SERIES_MAX_DAYS * 24 * HOUR).toISOString();
        expect(resolveEarningsSince("2020-01-01T00:00:00Z", NOW)).toBe(floor);
        expect(resolveEarningsSince("2030-01-01T00:00:00Z", NOW)).toBe(new Date(NOW).toISOString());
    });
});

describe("countsTowardEarningsSeries", () => {
    it("keeps money that is or may still be paid; drops void and spend", () => {
        expect(countsTowardEarningsSeries({ status: "confirmed", kind: "paid" })).toBe(true);
        expect(countsTowardEarningsSeries({ status: "pending", kind: "paid" })).toBe(true);
        expect(countsTowardEarningsSeries({ status: "pending_approval", kind: "reservation" })).toBe(true);
        expect(countsTowardEarningsSeries({ status: "void", kind: "subsidy" })).toBe(false);
        expect(countsTowardEarningsSeries({ status: "confirmed", kind: "spent_on_compute" })).toBe(false);
    });
});

describe("hourStartIso", () => {
    it("floors to the UTC hour", () => {
        expect(hourStartIso("2026-11-18T13:59:59.999Z")).toBe("2026-11-18T13:00:00.000Z");
        expect(hourStartIso("2026-11-18T06:15:00-07:00")).toBe("2026-11-18T13:00:00.000Z");
        expect(hourStartIso("garbage")).toBe(null);
    });
});

describe("bucketEarningsHourly", () => {
    it("groups per provider per hour, counts jobs, sums net amount and fee", () => {
        const rows = [
            { provider_id: "p1", job_id: "j1", kind: "paid", status: "confirmed", amount_usd: "0.0095", fee_usd: "0.0005", earned_at: "2026-11-18T10:05:00Z" },
            { provider_id: "p1", job_id: "j2", kind: "paid", status: "pending", amount_usd: 0.019, fee_usd: 0.001, earned_at: "2026-11-18T10:55:00Z" },
            { provider_id: "p2", job_id: "j3", kind: "paid", status: "confirmed", amount_usd: 0.1, fee_usd: 0.005, earned_at: "2026-11-18T10:30:00Z" },
            { provider_id: "p1", job_id: null, kind: "reservation", status: "pending_approval", amount_usd: 1.9, fee_usd: 0.1, earned_at: "2026-11-18T11:00:00Z" },
            { provider_id: "p1", job_id: "j4", kind: "subsidy", status: "void", amount_usd: 5, fee_usd: 0, earned_at: "2026-11-18T11:10:00Z" },
            { provider_id: "p1", job_id: null, kind: "spent_on_compute", status: "confirmed", amount_usd: -3, fee_usd: 0, earned_at: "2026-11-18T11:20:00Z" },
            { provider_id: "p1", job_id: "j5", kind: "paid", status: "confirmed", amount_usd: 1, fee_usd: 0, earned_at: null }
        ];
        expect(bucketEarningsHourly(rows)).toEqual([
            { provider_id: "p1", at: "2026-11-18T10:00:00.000Z", jobs: 2, amount_usd: 0.0285, fee_usd: 0.0015, gross_usd: 0.03, own_jobs: 0, own_usd: 0 },
            { provider_id: "p2", at: "2026-11-18T10:00:00.000Z", jobs: 1, amount_usd: 0.1, fee_usd: 0.005, gross_usd: 0.105, own_jobs: 0, own_usd: 0 },
            { provider_id: "p1", at: "2026-11-18T11:00:00.000Z", jobs: 0, amount_usd: 1.9, fee_usd: 0.1, gross_usd: 2, own_jobs: 0, own_usd: 0 }
        ]);
    });

    it("splits out what the operator's own accounts paid", () => {
        const rows = [
            { provider_id: "p1", job_id: "j1", kind: "paid", status: "confirmed", amount_usd: 0.00095, fee_usd: 0.00005, earned_at: "2026-11-18T10:05:00Z", metadata: { billed_user_id: "ADMIN-1" } },
            { provider_id: "p1", job_id: "j2", kind: "paid", status: "confirmed", amount_usd: 0.0019, fee_usd: 0.0001, earned_at: "2026-11-18T10:06:00Z", metadata: { billed_user_id: "someone-else" } },
            { provider_id: "p1", job_id: "j3", kind: "paid", status: "confirmed", amount_usd: 0.001, fee_usd: 0, earned_at: "2026-11-18T10:07:00Z" }
        ];
        const [b] = bucketEarningsHourly(rows, { ownPayers: ["admin-1"] });
        expect(b).toMatchObject({ jobs: 3, own_jobs: 1, own_usd: 0.00095 });
        expect(b.amount_usd).toBeCloseTo(0.00385, 8);
    });

    it("is empty for no rows", () => {
        expect(bucketEarningsHourly([])).toEqual([]);
        expect(bucketEarningsHourly(undefined)).toEqual([]);
    });
});

describe("c0mpute node helpers", () => {
    it("parses board ids and maps bridged providers", () => {
        expect(parseC0mputeNodeIds("sdNT3kCN, ffig7P4J,bad,0OIl0OIl,sdNT3kCN")).toEqual(["sdNT3kCN", "ffig7P4J"]);
        expect(parseC0mputeNodeIds(null)).toEqual([]);
        expect(c0mputeNodeOf("c0mpute:12D3KooWLxQZFJhZer1mywvnti85VeMTCRhJveunvYExsdNT3kCN")).toBe("sdNT3kCN");
        expect(c0mputeNodeOf("provider-e98c6ec2")).toBeNull();
    });
    it("own payers: the user, plus every admin when the user is one", () => {
        expect(ownPayerIds("U1")).toEqual(["u1"]);
        expect(ownPayerIds("u1", { isAdmin: true, adminIds: ["a2", ""] })).toEqual(["u1", "a2"]);
    });
});

// ---- route: GET /api/v1/billing/node-earnings -----------------------------

const TRUSTED_KEY = "ifc_test_trusted_key";
const state = { userId: "u1", caller: null, providers: [], bridged: [], earnings: [], queries: [] };

function fakeClient() {
    return {
        from(table) {
            const q = { table, filters: [] };
            const chain = {
                select() { return chain; },
                in(col, v) { q.filters.push(["in", col, v]); return chain; },
                gte(col, v) { q.filters.push(["gte", col, v]); return chain; },
                not(col, op, v) { q.filters.push(["not", col, op, v]); return chain; },
                or(v) {
                    q.filters.push(["or", v]);
                    state.queries.push(q);
                    return Promise.resolve({ data: table === "providers" ? state.bridged : [], error: null });
                },
                order() { return chain; },
                range(from) {
                    state.queries.push(q);
                    const data = table === "provider_earnings" && from === 0 ? state.earnings : [];
                    return Promise.resolve({ data, error: null });
                }
            };
            return chain;
        }
    };
}

vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fakeClient() }));
vi.mock("@/lib/data/dashboard", () => ({ getUserProviders: async () => state.providers }));
vi.mock("@/lib/data/interactive-billing", () => ({ userIdForCoinpaySubject: async () => state.userId }));
vi.mock("@/lib/data/api-keys", () => ({ billingCaller: async () => state.caller }));

process.env.INFERNET_TRUSTED_CLIENT_KEYS = `c0mpute:${createHash("sha256").update(TRUSTED_KEY).digest("hex")}`;
const { GET } = await import("@/app/api/v1/billing/node-earnings/route");

function req(query = "", headers = {}) {
    return new Request(`https://infernetprotocol.com/api/v1/billing/node-earnings${query}`, { headers });
}

beforeEach(() => {
    state.userId = "u1";
    state.caller = null;
    state.queries = [];
    state.bridged = [];
    state.providers = [{ id: "p1", name: "rig-a", node_id: "n1", public_key: "pk1", status: "available", archived_at: null, address: "10.0.0.1", port: 8080, specs: { secret: 1 } }];
    state.earnings = [
        { id: 1, provider_id: "p1", job_id: "j1", kind: "paid", status: "confirmed", amount_usd: "0.95", fee_usd: "0.05", earned_at: new Date(Date.now() - 2 * HOUR).toISOString() }
    ];
});

describe("GET /api/v1/billing/node-earnings", () => {
    it("401s without auth", async () => {
        const res = await GET(req());
        expect(res.status).toBe(401);
    });

    it("400s for a trusted client that names nobody", async () => {
        const res = await GET(req("", { authorization: `Bearer ${TRUSTED_KEY}` }));
        expect(res.status).toBe(400);
    });

    it("answers linked:false for an unlinked CoinPay subject", async () => {
        state.userId = null;
        const res = await GET(req("", { authorization: `Bearer ${TRUSTED_KEY}`, "x-infernet-billed-subject": "sub-1" }));
        expect(res.status).toBe(200);
        const { data } = await res.json();
        expect(data).toMatchObject({ linked: false, providers: [], buckets: [] });
    });

    it("returns hourly buckets and public provider fields for a trusted subject", async () => {
        const res = await GET(req("?since=2000-01-01T00:00:00Z", { authorization: `Bearer ${TRUSTED_KEY}`, "x-infernet-billed-subject": "sub-1" }));
        expect(res.status).toBe(200);
        const { data } = await res.json();
        expect(data.linked).toBe(true);
        expect(Date.parse(data.since)).toBeGreaterThanOrEqual(Date.now() - 31 * 24 * HOUR - 60_000);
        expect(typeof data.generated_at).toBe("string");
        expect(data.providers).toEqual([{ id: "p1", name: "rig-a", node_id: "n1", public_key: "pk1", status: "available", archived_at: null, c0mpute_node: null }]);
        expect(data.buckets).toEqual([
            { provider_id: "p1", at: hourStartIso(state.earnings[0].earned_at), jobs: 1, amount_usd: 0.95, fee_usd: 0.05, gross_usd: 1, own_jobs: 0, own_usd: 0 }
        ]);
        const q = state.queries.find((x) => x.table === "provider_earnings");
        expect(q.filters).toContainEqual(["in", "provider_id", ["p1"]]);
        expect(q.filters).toContainEqual(["gte", "earned_at", data.since]);
        expect(q.filters).toContainEqual(["not", "status", "in", "(void)"]);
        expect(q.filters).toContainEqual(["not", "kind", "in", "(spent_on_compute)"]);
    });

    it("adds the providers of c0mpute nodes a trusted client names", async () => {
        state.bridged = [{ id: "pc", name: "c0mpute sdNT3kCN", node_id: "c0mpute:12D3KooWLxQZFJhZer1mywvnti85VeMTCRhJveunvYExsdNT3kCN", public_key: null, status: "c0mpute", archived_at: null }];
        const res = await GET(req("?c0mpute_nodes=sdNT3kCN,nope", { authorization: `Bearer ${TRUSTED_KEY}`, "x-infernet-billed-subject": "sub-1" }));
        const { data } = await res.json();
        expect(data.providers.map((p) => [p.id, p.c0mpute_node])).toEqual([["p1", null], ["pc", "sdNT3kCN"]]);
        const q = state.queries.find((x) => x.table === "provider_earnings");
        expect(q.filters).toContainEqual(["in", "provider_id", ["p1", "pc"]]);
        expect(state.queries.find((x) => x.table === "providers").filters).toContainEqual(["or", "node_id.like.c0mpute:%sdNT3kCN"]);
    });

    it("ignores c0mpute_nodes from a signed-in caller (only a trusted client vouches for nodes)", async () => {
        state.caller = { id: "u1" };
        state.bridged = [{ id: "pc", node_id: "c0mpute:x" }];
        const res = await GET(req("?c0mpute_nodes=sdNT3kCN", { authorization: "Bearer ik_live_x" }));
        const { data } = await res.json();
        expect(data.providers.map((p) => p.id)).toEqual(["p1"]);
    });

    it("serves a signed-in caller their own earnings", async () => {
        state.caller = { id: "u1" };
        const res = await GET(req("", { authorization: "Bearer ik_live_x" }));
        expect(res.status).toBe(200);
        const { data } = await res.json();
        expect(data.linked).toBe(true);
        expect(data.buckets).toHaveLength(1);
    });

    it("skips the earnings query when the user runs no nodes", async () => {
        state.caller = { id: "u1" };
        state.providers = [];
        const res = await GET(req("", { authorization: "Bearer ik_live_x" }));
        const { data } = await res.json();
        expect(data).toMatchObject({ linked: true, providers: [], buckets: [] });
        expect(state.queries.filter((x) => x.table === "provider_earnings")).toHaveLength(0);
    });
});
