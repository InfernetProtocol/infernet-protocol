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

const { createChatJob, noProviderError, isModelAlias, aliasTargetFor } = await import("@/lib/data/chat");

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

    it("a live provider serving another open model does not take a named open model", async () => {
        state.providers = [{ id: "p1", reputation: 50, specs: { served_models: ["qwen2.5:0.5b"] } }];
        const { job, source } = await createChatJob({ messages, modelName: "llama3.1:70b" });
        expect(source).toBe("none");
        expect(job.status).toBe("failed");
        expect(job.model_name).toBe("llama3.1:70b");
    });

    it.each(["gpt-4o-mini", "gpt-5.2-mini", "auto/best-fast", "auto", "o3-mini", "claude-3-5-sonnet"])(
        "a client default like %s runs on a model a live node serves",
        async (alias) => {
            state.providers = [{ id: "p1", reputation: 50, specs: { served_models: ["qwen2.5:0.5b", "gemma3:4b"] } }];
            const { job, source, requestedModel } = await createChatJob({ messages, modelName: alias });
            expect(source).toBe("p2p");
            expect(job.status).toBe("assigned");
            expect(job.provider_id).toBe("p1");
            expect(job.model_name).toBe("gemma3:4b");
            expect(job.title).toBe("chat:gemma3:4b");
            expect(job.input_spec.requested_model).toBe(alias);
            expect(requestedModel).toBe(alias);
        }
    );

    it("an alias with no live node at all still fails cleanly", async () => {
        const { job, source } = await createChatJob({ messages, modelName: "gpt-4o-mini" });
        expect(source).toBe("none");
        expect(job.status).toBe("failed");
        expect(job.model_name).toBe("gpt-4o-mini");
    });

    it("the NIM fallback gets its own default model for an alias, never gpt-4o-mini", async () => {
        process.env.NVIDIA_NIM_API_KEY = "nvapi-test";
        const { job, source, requestedModel } = await createChatJob({ messages, modelName: "gpt-4o-mini" });
        expect(source).toBe("nim");
        expect(job.model_name).not.toBe("gpt-4o-mini");
        expect(requestedModel).toBe("gpt-4o-mini");
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

describe("model aliases", () => {
    it("recognises client defaults and placeholders, not open model names", () => {
        for (const m of ["gpt-4o-mini", "GPT-4o", "gpt-3.5-turbo", "chatgpt-4o-latest", "o1", "o3-mini", "auto", "auto/best-fast", "default", "claude-3-haiku", "gemini-1.5-flash"]) {
            expect(isModelAlias(m), m).toBe(true);
        }
        for (const m of ["qwen2.5:7b", "llama3.2:1b", "gemma3:4b", "gpt-oss:20b", "gpt-oss:120b", "autoencoder:1b", "", undefined, null]) {
            expect(isModelAlias(m), String(m)).toBe(false);
        }
    });

    it("picks the preferred served model, else the first served", () => {
        expect(aliasTargetFor({ specs: { served_models: ["qwen2.5:0.5b", "qwen2.5:7b"] } })).toBe("qwen2.5:7b");
        expect(aliasTargetFor({ specs: { served_models: ["mystery:1b", "other:2b"] } })).toBe("mystery:1b");
        expect(aliasTargetFor({ specs: {} })).toBeNull();
        expect(aliasTargetFor(null)).toBeNull();
    });
});
