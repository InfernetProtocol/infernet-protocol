import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// createChatJob with no live provider and no NIM fallback. Nothing ever picks
// up an unassigned 'pending' chat job, so it must be recorded as failed with a
// no_provider error instead of sitting pending forever.
const state = { providers: [], inserted: [] };

function fakeClient() {
    return {
        from(table) {
            let insertRow = null;
            const q = {
                select() { return q; },
                eq() { return q; },
                gte() { return q; },
                insert(row) { insertRow = row; state.inserted.push(row); return q; },
                maybeSingle() { return Promise.resolve({ data: null, error: null }); },
                single() { return Promise.resolve({ data: { id: "job-1", ...insertRow }, error: null }); },
                then(resolve, reject) {
                    const data = table === "providers" ? state.providers : [];
                    return Promise.resolve({ data, error: null }).then(resolve, reject);
                }
            };
            return q;
        }
    };
}

vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fakeClient() }));
vi.mock("@/lib/encrypt", () => ({ encryptJSON: (v) => v, decryptJSON: (v) => v }));

const { createChatJob, noProviderError } = await import("@/lib/data/chat");

const messages = [{ role: "user", content: "hi" }];

beforeEach(() => {
    state.providers = [];
    state.inserted = [];
    delete process.env.NVIDIA_NIM_API_KEY;
});

afterEach(() => {
    delete process.env.NVIDIA_NIM_API_KEY;
});

describe("createChatJob with nothing to serve the request", () => {
    it("records the job as failed with a no_provider error, never pending", async () => {
        const { job, provider, source } = await createChatJob({ messages, modelName: "gpt-4o-mini" });
        expect(source).toBe("none");
        expect(provider).toBeNull();
        expect(job.status).toBe("failed");
        expect(job.error).toBe(noProviderError("gpt-4o-mini"));
        expect(job.error).toMatch(/^no_provider: .*"gpt-4o-mini"/);
        expect(job.completed_at).toBeTruthy();
        expect(job.model_name).toBe("gpt-4o-mini");
    });

    it("a live provider serving another model does not take the job", async () => {
        state.providers = [{ id: "p1", reputation: 50, specs: { served_models: ["qwen2.5:0.5b"] } }];
        const { job, source } = await createChatJob({ messages, modelName: "gpt-4o-mini" });
        expect(source).toBe("none");
        expect(job.status).toBe("failed");
    });

    it("a live provider serving the model gets it assigned", async () => {
        state.providers = [{ id: "p1", reputation: 50, specs: { served_models: ["qwen2.5:0.5b"] } }];
        const { job, source } = await createChatJob({ messages, modelName: "qwen2.5:0.5b" });
        expect(source).toBe("p2p");
        expect(job.status).toBe("assigned");
        expect(job.provider_id).toBe("p1");
        expect(job.error).toBeUndefined();
    });

    it("the NIM fallback still takes it when configured", async () => {
        process.env.NVIDIA_NIM_API_KEY = "nvapi-test";
        const { job, source } = await createChatJob({ messages, modelName: "gpt-4o-mini" });
        expect(source).toBe("nim");
        expect(job.status).toBe("running");
        expect(job.error).toBeUndefined();
    });

    it("no model named still gets a readable error", () => {
        expect(noProviderError()).toMatch(/^no_provider: no live provider/);
    });
});
