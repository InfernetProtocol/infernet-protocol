import { beforeEach, describe, expect, it, vi } from "vitest";

// issueCommand refuses a node that is not heartbeating (a queued command
// only reaches a running daemon), and completion errors are stored without
// the terminal escape codes ollama/hf mix into them.
const state = { provider: null, inserted: [] };

function fakeClient() {
    return {
        from(table) {
            let insertRow = null;
            const q = {
                select() { return q; },
                eq() { return q; },
                insert(row) { insertRow = row; state.inserted.push({ table, row }); return q; },
                maybeSingle() {
                    return Promise.resolve({ data: table === "providers" ? state.provider : null, error: null });
                },
                single() { return Promise.resolve({ data: { id: "cmd-1", ...insertRow }, error: null }); }
            };
            return q;
        }
    };
}

vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fakeClient() }));

const { issueCommand, assertNodeLive, cleanCommandError } = await import("@/lib/data/node-commands");

beforeEach(() => {
    state.provider = null;
    state.inserted = [];
});

describe("issueCommand liveness", () => {
    it("queues a command for a node seen in the last 10 minutes", async () => {
        state.provider = { last_seen: new Date(Date.now() - 60_000).toISOString() };
        const row = await issueCommand({ userId: "u1", pubkey: "pk", command: "model_install", args: { model: "qwen2.5:0.5b" } });
        expect(row.status).toBe("pending");
        expect(state.inserted).toHaveLength(1);
    });

    it("refuses an offline node with 409 and queues nothing", async () => {
        state.provider = { last_seen: "2026-09-13T13:00:00Z" };
        await expect(issueCommand({ userId: "u1", pubkey: "pk", command: "model_install", args: { model: "x" } }))
            .rejects.toMatchObject({ status: 409, message: expect.stringContaining("offline (last heartbeat 2026-09-13") });
        expect(state.inserted).toHaveLength(0);
    });

    it("refuses a node that never sent a heartbeat", async () => {
        await expect(assertNodeLive("pk")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("never sent a heartbeat") });
    });
});

describe("cleanCommandError", () => {
    it("strips cursor and sync codes so the cause is readable", () => {
        const raw = "ollama exited 1: \x1B[?25l\x1B[?2026h\x1B[?25l\x1B[?25h\x1B[?2026l\x1B[?25hError: model 'qwen2.5:0.5b' not found\n";
        expect(cleanCommandError(raw)).toBe("ollama exited 1: Error: model 'qwen2.5:0.5b' not found");
    });

    it("keeps only the last frame of a carriage-return spinner", () => {
        expect(cleanCommandError("pulling manifest ⠋\rpulling manifest ⠙\rError: pull model manifest: file does not exist"))
            .toBe("Error: pull model manifest: file does not exist");
    });

    it("keeps the tail of very long output, where the cause is", () => {
        const out = cleanCommandError("x".repeat(5000) + "\nTHE CAUSE");
        expect(out.length).toBeLessThanOrEqual(2001);
        expect(out.endsWith("THE CAUSE")).toBe(true);
    });

    it("passes plain messages and non-strings through", () => {
        expect(cleanCommandError("huggingface_hub not installed.")).toBe("huggingface_hub not installed.");
        expect(cleanCommandError(undefined)).toBeUndefined();
    });
});
