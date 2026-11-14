import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LLM chat on c0mpute workers (workload infernet.inference) through the c0mpute
// jobs bridge, when no Infernet provider serves the model.

const state = { providers: [], inserted: [], fallbackToday: 0 };

function fakeClient() {
    return {
        from(table) {
            let insertRow = null;
            let head = false;
            const q = {
                select(_c, opts) { head = Boolean(opts?.head); return q; },
                is() { return q; },
                not() { return q; },
                eq() { return q; },
                gte() { return q; },
                in() { return q; },
                order() { return q; },
                update() { return q; },
                insert(row) { insertRow = row; state.inserted.push(row); return q; },
                maybeSingle() { return Promise.resolve({ data: null, error: null }); },
                single() { return Promise.resolve({ data: { id: "job-1", ...insertRow }, error: null }); },
                then(resolve, reject) {
                    if (head) return Promise.resolve({ count: state.fallbackToday, error: null }).then(resolve, reject);
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

const c0 = await import("@/lib/chat/c0mpute-inference");
const { createChatJob, c0mputeModelFor, listChatModels, c0mputeEligible, C0MPUTE_ROUTE } = await import("@/lib/data/chat");
const { moveC0mputeJobToProvider, settleC0mputeJob, c0mputeNodeId, isPeerId } = await import("@/lib/data/chat-c0mpute");
const { llmProvidersCard } = await import("@/lib/data/network-nodes");

const STATUS = {
    ok: true,
    network: {
        workers_online: 16,
        workers_with_tag: {
            "infernet:inference": 4,
            "infernet:inference:model:qwen2.5:0.5b": 4,
            "infernet:inference:model:qwen2.5:7b": 2,
            "infernet:inference:model:qwen3:4b": 2,
            "infernet:inference:model:hf.co/profullstack/tax-guy-agent-GGUF:latest": 4,
            "infernet:inference:model:huihui_ai/qwen3.5-abliterated:9b": 2,
            "tts:kokoro": 9
        }
    }
};

const messages = [{ role: "user", content: "hi" }];
const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
    state.providers = [];
    state.inserted = [];
    state.fallbackToday = 0;
    c0.resetC0mputeInferenceCache();
    delete process.env.NVIDIA_NIM_API_KEY;
    process.env.C0MPUTE_JOBS_URL = "http://c0mpute-jobs-infernet:8788/";
    process.env.C0MPUTE_JOBS_TOKEN = "t".repeat(32);
    globalThis.fetch = vi.fn(async (url) => {
        if (String(url).includes("/api/status")) return jsonResponse(STATUS);
        throw new Error(`unexpected fetch ${url}`);
    });
});

afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.C0MPUTE_JOBS_URL;
    delete process.env.C0MPUTE_JOBS_TOKEN;
    delete process.env.NVIDIA_NIM_API_KEY;
});

describe("summarizeC0mputeInference", () => {
    it("counts infernet:inference workers and per-model tags", () => {
        const s = c0.summarizeC0mputeInference(STATUS);
        expect(s.workers).toBe(4);
        expect(s.models["qwen2.5:7b"]).toBe(2);
        expect(s.models["hf.co/profullstack/tax-guy-agent-GGUF:latest"]).toBe(4);
        expect(Object.keys(s.models)).not.toContain("tts:kokoro");
    });

    it("rejects an HTML outage page or a missing tag map", () => {
        expect(c0.summarizeC0mputeInference(null)).toBeNull();
        expect(c0.summarizeC0mputeInference("<html>")).toBeNull();
        expect(c0.summarizeC0mputeInference({ network: {} })).toBeNull();
        expect(c0.summarizeC0mputeInference({ network: { workers_with_tag: {} } })).toEqual({ workers: 0, models: {} });
    });

    it("keeps the last good answer when the status endpoint fails", async () => {
        const ok = vi.fn(async () => jsonResponse(STATUS));
        expect((await c0.fetchC0mputeInference({ fetchImpl: ok, now: 1_000 })).workers).toBe(4);
        const down = vi.fn(async () => { throw new Error("down"); });
        expect((await c0.fetchC0mputeInference({ fetchImpl: down, now: 100_000 })).workers).toBe(4);
        expect(down).toHaveBeenCalled();
    });
});

describe("the feature check", () => {
    it("is off without both C0MPUTE_JOBS_URL and C0MPUTE_JOBS_TOKEN", async () => {
        expect(c0.c0mputeJobsBridge({})).toBeNull();
        expect(c0.c0mputeJobsBridge({ C0MPUTE_JOBS_URL: "http://x" })).toBeNull();
        expect(c0.c0mputeJobsBridge({ C0MPUTE_JOBS_URL: "http://x/", C0MPUTE_JOBS_TOKEN: "k" })).toEqual({ baseUrl: "http://x", token: "k" });
        delete process.env.C0MPUTE_JOBS_URL;
        expect(await c0.c0mputeChatModels()).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

describe("buildSpec", () => {
    it("keeps chat turns only and never ends on the assistant", () => {
        const spec = c0.buildSpec({
            model: "qwen2.5:7b",
            messages: [
                { role: "system", content: "be brief" },
                { role: "tool", content: "x" },
                { role: "user", content: "hi" },
                { role: "assistant", content: "hello" }
            ],
            maxTokens: 99999,
            temperature: 7
        });
        expect(spec).toEqual({
            v: 1,
            model: "qwen2.5:7b",
            messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }],
            max_tokens: 4096,
            temperature: 2
        });
    });

    it("drops the oldest turns past 64 messages or 64 KiB, keeping the system prompt", () => {
        const many = [{ role: "system", content: "sys" }];
        for (let i = 0; i < 80; i += 1) many.push({ role: i % 2 ? "assistant" : "user", content: `m${i}` });
        many.push({ role: "user", content: "last" });
        const fitted = c0.fitMessages(many);
        expect(fitted.length).toBe(64);
        expect(fitted[0]).toEqual({ role: "system", content: "sys" });
        expect(fitted.at(-1)).toEqual({ role: "user", content: "last" });

        const big = [{ role: "user", content: "a".repeat(40_000) }, { role: "user", content: "b".repeat(40_000) }];
        expect(c0.fitMessages(big)).toEqual([{ role: "user", content: "b".repeat(40_000) }]);
        expect(c0.fitMessages([{ role: "user", content: "c".repeat(70_000) }])).toBeNull();
        expect(c0.buildSpec({ messages: [{ role: "assistant", content: "x" }] })).toBeNull();
    });
});

describe("runC0mputeChat", () => {
    it("posts infernet.inference to the bridge and returns the answer and worker", async () => {
        const fetchImpl = vi.fn(async (url, init) => {
            expect(url).toBe("http://c0mpute-jobs-infernet:8788/v1/jobs");
            expect(init.headers.authorization).toBe(`Bearer ${"t".repeat(32)}`);
            const body = JSON.parse(init.body);
            expect(body.workload).toBe("infernet.inference");
            expect(body.spec.model).toBe("qwen2.5:7b");
            return jsonResponse({ job_id: "j1", worker: "12D3KooWorker", price: 0.001, output_hash: "h", result: { v: 1, ok: true, model: "qwen2.5:7b", text: "Hello there!" } });
        });
        const out = await c0.runC0mputeChat({ model: "qwen2.5:7b", messages }, { fetchImpl });
        expect(out).toMatchObject({ ok: true, text: "Hello there!", model: "qwen2.5:7b", worker: "12D3KooWorker", jobId: "j1", price: 0.001 });
    });

    it("reads a no-bid 503, a worker error and an unreachable bridge as failures", async () => {
        const noBids = vi.fn(async () => jsonResponse({ error: "no_bids", detail: "no bids received within 3s" }, 503));
        expect(await c0.runC0mputeChat({ messages }, { fetchImpl: noBids })).toMatchObject({ ok: false, code: "no_bids", status: 503 });
        const bad = vi.fn(async () => jsonResponse({ job_id: "j", worker: "w", result: { v: 1, ok: false, error: "model x is not served here" } }));
        const r = await c0.runC0mputeChat({ messages }, { fetchImpl: bad });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/not served here/);
        const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
        expect(await c0.runC0mputeChat({ messages }, { fetchImpl: down })).toMatchObject({ ok: false, code: "unreachable" });
    });
});

describe("c0mputeJobEvents", () => {
    const deps = () => {
        const events = [];
        const calls = { finalize: [], charge: [] };
        return {
            events,
            calls,
            insertEvent: async (jobId, type, data) => { events.push(type); return { id: events.length, data }; },
            finalize: async (jobId, patch) => { calls.finalize.push(patch); },
            charge: async (job, result) => { calls.charge.push(result); },
            log: () => {}
        };
    };
    const job = { id: "job-1", model_name: "qwen2.5:7b", billed_user_id: "u1", input_spec: { messages, fallback: "c0mpute", c0mpute_model: "qwen2.5:7b", max_tokens: 64 } };

    it("emits meta, the answer and done, then completes and bills the job", async () => {
        const d = deps();
        const run = vi.fn(async (args) => {
            expect(args).toMatchObject({ model: "qwen2.5:7b", maxTokens: 64 });
            return { ok: true, text: "hi!", model: "qwen2.5:7b", worker: "12D3W", jobId: "cj", price: 0.001, durationMs: 5 };
        });
        const out = [];
        for await (const ev of c0.c0mputeJobEvents(job, { ...d, run })) out.push(ev);
        expect(out.map((e) => e.type)).toEqual(["meta", "token", "done"]);
        expect(out[0].data.provider_node_id).toBe("c0mpute");
        expect(out[2].data).toMatchObject({ text: "hi!", worker: "12D3W", source: "c0mpute" });
        expect(d.events).toEqual(["meta", "token", "done"]);
        expect(d.calls.finalize[0]).toMatchObject({ status: "completed", result: { source: "c0mpute", text: "hi!" } });
        expect(d.calls.charge).toHaveLength(1);
    });

    it("reports a miss without persisting an error or billing", async () => {
        const d = deps();
        const run = vi.fn(async () => ({ ok: false, code: "no_bids", error: "no c0mpute worker took the request" }));
        const out = [];
        for await (const ev of c0.c0mputeJobEvents(job, { ...d, run })) out.push(ev);
        expect(out.map((e) => e.type)).toEqual(["meta", "c0mpute_failed"]);
        expect(d.events).toEqual(["meta"]);
        expect(d.calls.finalize).toEqual([]);
        expect(d.calls.charge).toEqual([]);
    });
});

describe("c0mputeModelFor", () => {
    const served = ["hf.co/profullstack/tax-guy-agent-GGUF:latest", "huihui_ai/qwen3.5-abliterated:9b", "qwen2.5:0.5b", "qwen2.5:7b", "qwen3:4b"];

    it("takes a named model only if a worker serves it", () => {
        expect(c0mputeModelFor(served, "qwen2.5:0.5b")).toBe("qwen2.5:0.5b");
        expect(c0mputeModelFor(served, "huihui_ai/qwen3.5-abliterated:9b")).toBe("huihui_ai/qwen3.5-abliterated:9b");
        expect(c0mputeModelFor(served, "llama3.1:70b")).toBeNull();
    });

    it("gives no model or an alias the best general chat model", () => {
        expect(c0mputeModelFor(served, undefined)).toBe("qwen2.5:7b");
        expect(c0mputeModelFor(served, "gpt-4o-mini")).toBe("qwen2.5:7b");
        // Never a single-purpose fine-tune, an uncensored build or a reasoning model by default.
        expect(c0mputeModelFor(["hf.co/x/agent:latest", "huihui_ai/qwen3.5-abliterated:4b", "qwen3:4b", "mistral:7b"], undefined)).toBe("mistral:7b");
        expect(c0mputeModelFor(["hf.co/x/agent:latest", "qwen3:4b"], "auto")).toBeNull();
        expect(c0mputeModelFor([], undefined)).toBeNull();
    });
});

describe("createChatJob and c0mpute", () => {
    it("sends a model no Infernet provider serves to c0mpute workers", async () => {
        state.providers = [{ id: "p1", reputation: 50, specs: { served_models: ["qwen2.5:0.5b"] } }];
        const { job, source, route, provider } = await createChatJob({ messages, modelName: "qwen2.5:7b" });
        expect(source).toBe("p2p");
        expect(route).toBe("c0mpute");
        expect(job.status).toBe("running");
        expect(job.provider_id).toBeNull();
        expect(job.model_name).toBe("qwen2.5:7b");
        expect(job.input_spec).toMatchObject({ fallback: "c0mpute", c0mpute_model: "qwen2.5:7b" });
        expect(job.input_spec.nim_ok).toBeUndefined();
        expect(provider).toMatchObject({ node_id: "c0mpute", model: "qwen2.5:7b" });
    });

    it("goes to c0mpute nodes first even when an Infernet daemon serves the model", async () => {
        state.providers = [{ id: "p1", reputation: 50, specs: { served_models: ["qwen2.5:7b"] } }];
        const { source, job, route } = await createChatJob({ messages, modelName: "qwen2.5:7b" });
        expect(source).toBe("p2p");
        expect(route).toBe("c0mpute");
        expect(job.provider_id).toBeNull();
        expect(job.input_spec).toMatchObject({ fallback: "c0mpute", c0mpute_model: "qwen2.5:7b" });
    });

    it("uses an Infernet daemon when no c0mpute node serves the model", async () => {
        state.providers = [{ id: "p1", reputation: 50, specs: { served_models: ["llama3.1:8b"] } }];
        const { source, job, route } = await createChatJob({ messages, modelName: "llama3.1:8b" });
        expect(source).toBe("p2p");
        expect(route).toBe("daemon");
        expect(job.provider_id).toBe("p1");
    });

    it("a retry that excludes c0mpute lands on a daemon", async () => {
        state.providers = [{ id: "p1", reputation: 50, specs: { served_models: ["qwen2.5:7b"] } }];
        const { source, job, route } = await createChatJob({ messages, modelName: "qwen2.5:7b", excludeProviderIds: [C0MPUTE_ROUTE] });
        expect(source).toBe("p2p");
        expect(route).toBe("daemon");
        expect(job.provider_id).toBe("p1");
    });

    it("comes before the billed hosted fallback, which it keeps as a backup", async () => {
        process.env.NVIDIA_NIM_API_KEY = "nvapi-test";
        const { source, job, requestedModel, route } = await createChatJob({ messages, modelName: "gpt-4o-mini" });
        expect(source).toBe("p2p");
        expect(route).toBe("c0mpute");
        expect(job.model_name).toBe("qwen2.5:7b");
        expect(requestedModel).toBe("gpt-4o-mini");
        expect(job.input_spec.nim_ok).toBe(true);
    });

    it("p2p_only allows c0mpute workers (peer nodes) but never arms the hosted backup", async () => {
        process.env.NVIDIA_NIM_API_KEY = "nvapi-test";
        const { source, job, route } = await createChatJob({ messages, noFallback: true });
        expect(source).toBe("p2p");
        expect(route).toBe("c0mpute");
        expect(job.input_spec.nim_ok).toBeUndefined();
    });

    it("never takes E2E, pinned, batch or distributed jobs, or a model nobody serves", async () => {
        expect((await createChatJob({ messages, modelName: "llama3.1:70b" })).source).toBe("none");
        expect((await createChatJob({ messages, distributed: true })).source).toBe("none");
        expect((await createChatJob({ messages, batchItemId: "b1" })).source).toBe("none");
        expect((await createChatJob({ messages, providerId: "p9", pinned: true })).source).toBe("none");
    });

    it("never sends a caller who asked for verified or trusted nodes to c0mpute", async () => {
        expect((await createChatJob({ messages, minTrustTier: "trusted" })).source).toBe("none");
        expect((await createChatJob({ messages, minTrustTier: "verified" })).source).toBe("none");
        expect((await createChatJob({ messages, minTrustTier: "public" })).route).toBe("c0mpute");
    });

    it("routes as before when the bridge is not configured", async () => {
        delete process.env.C0MPUTE_JOBS_TOKEN;
        expect((await createChatJob({ messages, modelName: "qwen2.5:7b" })).source).toBe("none");
    });

    it("lists c0mpute models in the public model list", async () => {
        const names = (await listChatModels()).map((m) => m.name);
        expect(names).toContain("qwen2.5:7b");
    });
});

describe("llmProvidersCard", () => {
    const summary = { online: 4, week: 8, dormant: 37 };

    it("sums Infernet providers and c0mpute inference workers and says how", () => {
        expect(llmProvidersCard(summary, { workers: 4, models: {} })).toEqual({
            label: "LLM providers online",
            value: 8,
            note: "4 Infernet + 4 c0mpute (may overlap) · 8 more seen this week · 37 dormant"
        });
    });

    it("says when no c0mpute worker serves chat, and when the count is unavailable", () => {
        expect(llmProvidersCard(summary, { workers: 0, models: {} })).toMatchObject({ value: 4, note: "4 Infernet + 0 c0mpute · 8 more seen this week · 37 dormant" });
        expect(llmProvidersCard({ online: 2, week: 0, dormant: 0 }, null)).toEqual({
            label: "LLM providers online",
            value: 2,
            note: "2 Infernet (c0mpute count unavailable)"
        });
    });
});

describe("c0mputeEligible", () => {
    const base = { messages };
    it("takes plaintext public chats", () => {
        expect(c0mputeEligible(base)).toBe(true);
        expect(c0mputeEligible({ ...base, minTrustTier: "public" })).toBe(true);
    });
    it("refuses E2E, addressed, pinned, distributed, reservation and batch jobs", () => {
        for (const extra of [{ e2e: true }, { providerId: "p1" }, { pinned: true }, { distributed: true }, { reservationId: "r" }, { batchItemId: "b" }]) {
            expect(c0mputeEligible({ ...base, ...extra })).toBe(false);
        }
    });
    it("refuses higher trust tiers, empty chats and a retry that excluded c0mpute", () => {
        expect(c0mputeEligible({ ...base, minTrustTier: "verified" })).toBe(false);
        expect(c0mputeEligible({ messages: [] })).toBe(false);
        expect(c0mputeEligible({ ...base, excludeProviderIds: ["p1", C0MPUTE_ROUTE] })).toBe(false);
    });
});

describe("a c0mpute job no worker answered moves to a daemon", () => {
    it("reassigns the same job to a provider serving the model, without the c0mpute fallback", async () => {
        state.providers = [{ id: "p1", name: "bonita", reputation: 50, specs: { served_models: ["qwen2.5:7b"] } }];
        const job = { id: "job-9", model_name: "qwen2.5:7b", input_spec: { messages, fallback: "c0mpute", c0mpute_model: "qwen2.5:7b", nim_ok: true } };
        const moved = await moveC0mputeJobToProvider(fakeClient(), job);
        expect(moved).toMatchObject({ id: "job-9", provider_id: "p1", status: "assigned", model_name: "qwen2.5:7b" });
        expect(moved.input_spec.fallback).toBeUndefined();
        expect(moved.input_spec.nim_ok).toBeUndefined();
        expect(moved.input_spec.messages).toEqual(messages);
    });
    it("returns null when no daemon serves it, so the hosted fallback can still take it", async () => {
        state.providers = [];
        const job = { id: "job-9", model_name: "qwen2.5:7b", input_spec: { messages, fallback: "c0mpute", c0mpute_model: "qwen2.5:7b" } };
        expect(await moveC0mputeJobToProvider(fakeClient(), job)).toBeNull();
    });
});

describe("the winning c0mpute worker is recorded as a provider", () => {
    const peer = "12D3KooWLvVoRHLQw1dZz3fqzVYqQZsZxCBc4x8gV9qDhVqKBdpB";
    it("creates a never-public, never-available provider row for the worker", async () => {
        const out = await settleC0mputeJob(fakeClient(), { id: "job-5", billed_user_id: null }, { worker: peer, text: "hi" });
        expect(out).toMatchObject({ billed: false, reason: "no_buyer" });
        const row = state.inserted.find((r) => r.node_id === c0mputeNodeId(peer));
        expect(row).toMatchObject({ status: "c0mpute", is_public: false, trust_tier: "public" });
        expect(row.specs.c0mpute_peer).toBe(peer);
    });
    it("ignores anything that is not a peer id", async () => {
        expect(isPeerId(peer)).toBe(true);
        for (const bad of [null, "", "c0mpute", "../../etc", "x".repeat(80)]) expect(isPeerId(bad)).toBe(false);
        await settleC0mputeJob(fakeClient(), { id: "job-6" }, { worker: "not a peer" });
        expect(state.inserted.some((r) => String(r.node_id ?? "").startsWith("c0mpute:"))).toBe(false);
    });
});

describe("source stays p2p for c0mpute nodes", () => {
    it("tells p2p_only clients a c0mpute job is a peer job, so they stream it", async () => {
        const { source, route } = await createChatJob({ messages, modelName: "qwen2.5:7b", noFallback: true });
        expect(source).toBe("p2p");
        expect(route).toBe("c0mpute");
    });
});

describe("bridgeFetch (node:http, no undici header timeout)", () => {
    it("posts JSON and reads ok/status/json, and a signal ends it", async () => {
        const { createServer } = await import("node:http");
        const server = createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                if (req.url === "/slow") return; // never answers
                const status = req.url === "/busy" ? 503 : 200;
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify({ got: JSON.parse(body), auth: req.headers.authorization }));
            });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            const init = { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) };
            const ok = await c0.bridgeFetch(`${base}/v1/jobs`, init);
            expect(ok.ok).toBe(true);
            expect(ok.status).toBe(200);
            expect(await ok.json()).toEqual({ got: { a: 1 }, auth: "Bearer x" });
            const busy = await c0.bridgeFetch(`${base}/busy`, init);
            expect(busy).toMatchObject({ ok: false, status: 503 });
            await expect(c0.bridgeFetch(`${base}/slow`, { ...init, signal: AbortSignal.timeout(100) })).rejects.toThrow();
        } finally {
            server.closeAllConnections?.();
            await new Promise((r) => server.close(r));
        }
    });

    it("gives a CPU network minutes, not 180 s", () => {
        expect(c0.DEFAULT_TIMEOUT_MS).toBeGreaterThan(300_000);
        expect(c0.DEFAULT_TIMEOUT_MS).toBeLessThan(600_000);
    });
});
