import { beforeEach, describe, expect, it, vi } from "vitest";

// completeJobForNode must be idempotent: a daemon that retries a completion
// (slow or lost response) must not re-mark the job or queue another CPR
// receipt. Production had 353 receipts queued for a single job.
const state = { job: null, updates: [], enqueued: 0 };

function fakeClient() {
    return {
        from(table) {
            let mode = "select";
            let patch = null;
            let statusFilter = null;
            const q = {
                select() { return q; },
                eq() { return q; },
                in(col, values) { if (col === "status") statusFilter = values; return q; },
                update(p) { mode = "update"; patch = p; return q; },
                insert() { return Promise.resolve({ error: null }); },
                maybeSingle() {
                    if (table === "providers") return Promise.resolve({ data: { id: "prov-1" }, error: null });
                    return Promise.resolve({ data: state.job ? { ...state.job } : null, error: null });
                },
                then(resolve, reject) {
                    let res = { data: null, error: null };
                    if (mode === "update" && table === "jobs") {
                        const ok = !statusFilter || statusFilter.includes(state.job.status);
                        if (ok) {
                            state.job = { ...state.job, ...patch };
                            state.updates.push(patch);
                            res = { data: [{ id: state.job.id }], error: null };
                        } else {
                            res = { data: [], error: null };
                        }
                    }
                    return Promise.resolve(res).then(resolve, reject);
                }
            };
            return q;
        }
    };
}

vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fakeClient() }));
vi.mock("@/lib/encrypt", () => ({ encryptJSON: (v) => v, decryptJSON: (v) => v }));
vi.mock("@/lib/cpr/queue", () => ({
    enqueueAndFlush: async () => { state.enqueued += 1; return "pending"; }
}));

const { completeJobForNode } = await import("@/lib/data/node-api");

beforeEach(() => {
    state.job = { id: "job-1", provider_id: "prov-1", payment_offer: 0, payment_coin: null, status: "assigned" };
    state.updates = [];
    state.enqueued = 0;
});

describe("completeJobForNode", () => {
    it("completes an in-flight job once and queues one receipt", async () => {
        const out = await completeJobForNode({ pubkey: "pk", jobId: "job-1", body: { status: "completed", result: { text: "hi" } } });
        expect(out).toEqual({ id: "job-1", status: "completed" });
        expect(state.updates).toHaveLength(1);
        expect(state.enqueued).toBe(1);
    });

    it("a retried completion is a no-op: no second update, no second receipt", async () => {
        await completeJobForNode({ pubkey: "pk", jobId: "job-1", body: { status: "completed" } });
        for (let i = 0; i < 5; i++) {
            const out = await completeJobForNode({ pubkey: "pk", jobId: "job-1", body: { status: "completed" } });
            expect(out).toMatchObject({ id: "job-1", status: "completed", noop: true });
        }
        expect(state.updates).toHaveLength(1);
        expect(state.enqueued).toBe(1);
    });

    it("does not overwrite a job the reaper already failed", async () => {
        state.job.status = "failed";
        const out = await completeJobForNode({ pubkey: "pk", jobId: "job-1", body: { status: "completed" } });
        expect(out).toMatchObject({ status: "failed", noop: true });
        expect(state.enqueued).toBe(0);
    });
});
