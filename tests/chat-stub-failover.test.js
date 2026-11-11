import { describe, expect, it } from "vitest";
import { failoverEvents, abandonReason } from "../apps/web/lib/data/chat-failover.js";
import { finishPick, aliasTargetFor } from "../apps/web/lib/data/chat.js";
import { stubExplicitlyChosen } from "../apps/cli/lib/chat-executor.js";

const STUB_TEXT = "Running on the Infernet P2P network. This is a stub response from the provider daemon";

function streams(map) {
    return async function* stream(jobId) {
        for (const ev of map[jobId] ?? []) yield ev;
    };
}

async function collect(gen) {
    const out = [];
    for await (const ev of gen) out.push(ev);
    return out;
}

describe("chat failover before the first token", () => {
    it("moves a stub-engine answer to another node and marks the stub job failed", async () => {
        const abandoned = [];
        const retries = [];
        const events = await collect(failoverEvents({ id: "j1", provider_id: "stubnode" }, {
            stream: streams({
                j1: [{ type: "job" }, { type: "meta", data: { engine: "stub" } }, { type: "token", data: { text: STUB_TEXT } }],
                j2: [{ type: "meta", data: { engine: "ollama" } }, { type: "token", data: { text: "hi" } }, { type: "done", data: { text: "hi" } }]
            }),
            retry: async (exclude) => { retries.push(exclude); return { id: "j2", provider_id: "real" }; },
            abandon: async (job, reason) => { abandoned.push([job.id, reason]); }
        }));
        expect(events.map((e) => e.type)).toEqual(["job", "meta", "token", "done"]);
        expect(events.some((e) => e.data?.text?.includes("stub response"))).toBe(false);
        expect(retries).toEqual([["stubnode"]]);
        expect(abandoned).toEqual([["j1", "node has no inference engine (stub backend)"]]);
    });

    it("retries an Ollama 404 on another node", async () => {
        const events = await collect(failoverEvents({ id: "j1", provider_id: "a" }, {
            stream: streams({
                j1: [{ type: "error", data: { message: "ollama HTTP 404: model 'qwen2.5:0.5b' not found" } }],
                j2: [{ type: "token", data: { text: "ok" } }, { type: "done", data: {} }]
            }),
            retry: async () => ({ id: "j2", provider_id: "b" }),
            abandon: async () => {}
        }));
        expect(events.map((e) => e.type)).toEqual(["token", "done"]);
    });

    it("passes an error after the first token through without retrying", async () => {
        let retried = false;
        const events = await collect(failoverEvents({ id: "j1", provider_id: "a" }, {
            stream: streams({ j1: [{ type: "token", data: { text: "par" } }, { type: "error", data: { message: "boom" } }] }),
            retry: async () => { retried = true; return null; },
            abandon: async () => {}
        }));
        expect(retried).toBe(false);
        expect(events.map((e) => e.type)).toEqual(["token", "error"]);
    });

    it("gives up after maxAttempts and reports the last failure, excluding every node tried", async () => {
        const seen = [];
        let n = 1;
        const map = {};
        for (let i = 1; i <= 5; i++) map[`j${i}`] = [{ type: "error", data: { message: `fail ${i}` } }];
        const events = await collect(failoverEvents({ id: "j1", provider_id: "p1" }, {
            stream: streams(map),
            retry: async (exclude) => { seen.push(exclude); n += 1; return { id: `j${n}`, provider_id: `p${n}` }; },
            abandon: async () => {},
            maxAttempts: 3
        }));
        expect(seen).toEqual([["p1"], ["p1", "p2"]]);
        expect(events).toEqual([{ type: "error", data: { message: "fail 3" } }]);
    });

    it("does not retry a hosted-fallback job (no provider)", async () => {
        let retried = false;
        const events = await collect(failoverEvents({ id: "j1", provider_id: null }, {
            stream: streams({ j1: [{ type: "error", data: { message: "nim down" } }] }),
            retry: async () => { retried = true; return null; },
            abandon: async () => {}
        }));
        expect(retried).toBe(false);
        expect(events).toEqual([{ type: "error", data: { message: "nim down" } }]);
    });

    it("abandonReason ignores real engines", () => {
        expect(abandonReason({ type: "meta", data: { engine: "ollama" } })).toBeNull();
        expect(abandonReason({ type: "token", data: { text: "x" } })).toBeNull();
    });
});

describe("routing never picks a node that serves no model", () => {
    const node = (id, served) => ({ id, reputation: 50, specs: { served_models: served, load: { active_jobs: 0 } } });

    it("skips nodes with empty served_models for a model-less request", () => {
        for (let i = 0; i < 20; i++) {
            expect(finishPick([node("stub", []), node("real", ["qwen2.5:7b"])], {}).id).toBe("real");
        }
        expect(finishPick([node("stub", []), { id: "nospecs", reputation: 50 }], {})).toBeNull();
    });

    it("resolves a model-less request to a model the node serves", () => {
        expect(aliasTargetFor(node("n", ["qwen3:8b", "qwen2.5:7b"]))).toBe("qwen2.5:7b");
    });
});

describe("daemon stub guard", () => {
    it("allows stub only when the operator chose it", () => {
        expect(stubExplicitlyChosen({}, {})).toBe(false);
        expect(stubExplicitlyChosen({ engine: { backend: "ollama" } }, {})).toBe(false);
        expect(stubExplicitlyChosen({ engine: { backend: "stub" } }, {})).toBe(true);
        expect(stubExplicitlyChosen({}, { INFERNET_ENGINE_BACKEND: "stub" })).toBe(true);
    });
});
