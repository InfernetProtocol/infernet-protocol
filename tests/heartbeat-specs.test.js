import { describe, expect, it, vi, beforeEach } from "vitest";

const supabaseState = {
    lookupResult: { data: { id: "row-1", public_key: "PK" }, error: null },
    updateCalls: []
};

function reset() {
    supabaseState.lookupResult = { data: { id: "row-1", public_key: "PK" }, error: null };
    supabaseState.updateCalls = [];
}

vi.mock("@/lib/supabase/server", () => ({
    getSupabaseServerClient: () => ({
        from(table) {
            const chain = {
                _table: table,
                _filters: {},
                _patch: null,
                select() { return chain; },
                eq(col, val) { chain._filters[col] = val; return chain; },
                async maybeSingle() { return supabaseState.lookupResult; },
                update(patch) { chain._patch = patch; return chain; },
                then(onF, onR) {
                    if (chain._patch) {
                        supabaseState.updateCalls.push({ table, patch: chain._patch, filters: chain._filters });
                    }
                    return Promise.resolve({ data: null, error: null }).then(onF, onR);
                }
            };
            return chain;
        }
    })
}));

const { heartbeatNode } = await import("@/lib/data/node-api");

describe("heartbeatNode — body.specs handling", () => {
    beforeEach(reset);

    it("updates last_seen + status without specs when body.specs is omitted", async () => {
        await heartbeatNode({ role: "provider", pubkey: "PK", body: {} });
        expect(supabaseState.updateCalls).toHaveLength(1);
        const patch = supabaseState.updateCalls[0].patch;
        expect(patch.last_seen).toBeTypeOf("string");
        expect(patch.status).toBe("available");
        // The whole point of the fix: do NOT clobber specs to null when not sent.
        expect(patch).not.toHaveProperty("specs");
    });

    it("persists specs when the daemon includes a fresh snapshot", async () => {
        const specs = {
            cpu: { vendor: "amd", arch: "x64", cores: 16, ram_gb: 64, groups: 1 },
            gpu_count: 0,
            gpus: [],
            interconnects: { rdma_capable: false },
            served_models: ["qwen2.5:0.5b"]
        };
        await heartbeatNode({ role: "provider", pubkey: "PK", body: { specs } });
        expect(supabaseState.updateCalls).toHaveLength(1);
        const patch = supabaseState.updateCalls[0].patch;
        expect(patch.specs).toEqual(specs);
    });

    it("ignores non-object specs values (defends against malformed payloads)", async () => {
        for (const garbage of ["string", 123, [1, 2, 3], null, true]) {
            reset();
            await heartbeatNode({ role: "provider", pubkey: "PK", body: { specs: garbage } });
            const patch = supabaseState.updateCalls[0].patch;
            expect(patch).not.toHaveProperty("specs");
        }
    });

    it("never brings an admin-disabled provider back to available", async () => {
        supabaseState.lookupResult = { data: { id: "row-1", public_key: "PK", disabled_at: "2026-11-02T00:00:00Z" }, error: null };
        await heartbeatNode({ role: "provider", pubkey: "PK", body: {} });
        expect(supabaseState.updateCalls[0].patch.status).toBe("disabled");
    });

    it("flags status=offline correctly when body.status === 'offline'", async () => {
        await heartbeatNode({ role: "provider", pubkey: "PK", body: { status: "offline" } });
        const patch = supabaseState.updateCalls[0].patch;
        expect(patch.status).toBe("offline");
    });

    it("does NOT set status for clients (status column doesn't apply)", async () => {
        await heartbeatNode({ role: "client", pubkey: "PK", body: { status: "available" } });
        const patch = supabaseState.updateCalls[0].patch;
        expect(patch).not.toHaveProperty("status");
    });

    it("returns 404-shaped error when no row exists for the pubkey", async () => {
        supabaseState.lookupResult = { data: null, error: null };
        await expect(
            heartbeatNode({ role: "provider", pubkey: "PK", body: {} })
        ).rejects.toMatchObject({ status: 404 });
    });
});
