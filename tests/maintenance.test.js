import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake Supabase client that records every query: table, the update patch
// (if any) and each filter. Updates resolve to `state.reaped[table]` ids,
// head counts to `state.counts[table]`.
const state = { calls: [], reaped: {}, counts: {}, fail: null };

function fakeClient() {
    return {
        from(table) {
            const call = { table, patch: null, filters: [], head: false };
            state.calls.push(call);
            const result = () => {
                if (state.fail === table) return { data: null, count: null, error: { message: `boom on ${table}` } };
                if (call.head) return { data: null, count: state.counts[table] ?? 0, error: null };
                return { data: (state.reaped[table] ?? []).map((id) => ({ id })), error: null };
            };
            const q = {
                update(patch) { call.patch = patch; return q; },
                select(_cols, opts) { call.head = Boolean(opts?.head); return q; },
                in(col, vals) { call.filters.push(["in", col, vals]); return q; },
                eq(col, val) { call.filters.push(["eq", col, val]); return q; },
                lt(col, val) { call.filters.push(["lt", col, val]); return q; },
                then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
            };
            return q;
        }
    };
}

vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fakeClient() }));

const { POST } = await import("@/app/api/cron/maintenance/route");
const { reapStaleState, REAP_RULES } = await import("@/lib/maintenance");

function req(path = "/api/cron/maintenance", headers = { authorization: "Bearer s3cret" }) {
    return new Request(`https://infernetprotocol.com${path}`, { method: "POST", headers });
}

beforeEach(() => {
    process.env.CRON_SECRET = "s3cret";
    state.calls = [];
    state.reaped = {};
    state.counts = {};
    state.fail = null;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("reapStaleState", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const iso = (ms) => new Date(now.getTime() - ms).toISOString();

    it("expires stuck jobs, times out commands, marks silent providers offline", async () => {
        state.reaped = { jobs: ["j1", "j2"], node_commands: ["c1"], providers: ["p1", "p2", "p3"] };
        const out = await reapStaleState(fakeClient(), { now });
        expect(out).toEqual({ jobs: 2, commands: 1, providers: 3, dryRun: false });

        const [jobs, cmds, provs] = state.calls;
        expect(jobs.table).toBe("jobs");
        expect(jobs.patch).toMatchObject({ status: "failed", completed_at: now.toISOString() });
        expect(jobs.patch.error).toMatch(/^expired:/);
        expect(jobs.filters).toEqual([
            ["in", "status", ["pending", "assigned", "running"]],
            ["lt", "updated_at", iso(REAP_RULES.jobAfterMs)]
        ]);

        expect(cmds.table).toBe("node_commands");
        expect(cmds.patch).toMatchObject({ status: "failed" });
        expect(cmds.patch.error).toMatch(/^timed out:/);
        expect(cmds.filters).toEqual([
            ["in", "status", ["pending", "running"]],
            ["lt", "issued_at", iso(REAP_RULES.commandAfterMs)]
        ]);

        expect(provs.table).toBe("providers");
        expect(provs.patch).toEqual({ status: "offline" });
        expect(provs.filters).toEqual([
            ["eq", "status", "available"],
            ["lt", "last_seen", iso(REAP_RULES.providerAfterMs)]
        ]);
    });

    it("never touches completed work", async () => {
        await reapStaleState(fakeClient(), { now });
        for (const call of state.calls) {
            const statuses = call.filters.filter(([, col]) => col === "status").flatMap(([, , v]) => [v].flat());
            expect(statuses).not.toContain("completed");
            expect(statuses).not.toContain("failed");
        }
    });

    it("dry run only counts", async () => {
        state.counts = { jobs: 91, node_commands: 21, providers: 18 };
        const out = await reapStaleState(fakeClient(), { now, dryRun: true });
        expect(out).toEqual({ jobs: 91, commands: 21, providers: 18, dryRun: true });
        expect(state.calls.every((c) => c.patch === null && c.head)).toBe(true);
    });

    it("throws on a query error", async () => {
        state.fail = "node_commands";
        await expect(reapStaleState(fakeClient(), { now })).rejects.toThrow(/node_commands/);
    });
});

describe("POST /api/cron/maintenance", () => {
    it("rejects a missing or wrong secret, and everything when CRON_SECRET is unset", async () => {
        expect((await POST(req("/api/cron/maintenance", {}))).status).toBe(401);
        expect((await POST(req("/api/cron/maintenance", { authorization: "Bearer nope" }))).status).toBe(401);
        delete process.env.CRON_SECRET;
        expect((await POST(req("/api/cron/maintenance", { authorization: "Bearer " }))).status).toBe(401);
        expect(state.calls).toHaveLength(0);
    });

    it("reaps and reports the counts", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        state.reaped = { jobs: ["j1"] };
        const res = await POST(req());
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual({ jobs: 1, commands: 0, providers: 0, dryRun: false });
    });

    it("?dry_run=1 changes nothing", async () => {
        const res = await POST(req("/api/cron/maintenance?dry_run=1", { "x-cron-secret": "s3cret" }));
        expect(res.status).toBe(200);
        expect((await res.json()).data.dryRun).toBe(true);
        expect(state.calls.every((c) => c.patch === null)).toBe(true);
    });

    it("a query error is a 500", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        state.fail = "jobs";
        expect((await POST(req())).status).toBe(500);
    });
});
