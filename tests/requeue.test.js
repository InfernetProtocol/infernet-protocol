import { describe, expect, it } from "vitest";
import { requeueDecision, isTurnAwayError, MAX_REQUEUES } from "../apps/web/lib/routing/requeue.js";
import { isTurnAwayError as cliIsTurnAway, requeueTurnedAway } from "../apps/cli/lib/turn-away.js";

// Anthony, 2026-11-18: "if it turns away a job send it back to the front of the queue".
const gpu = { id: "gpu", specs: { bench: { tokens_per_second_avg: 40 } } };
const cpu = { id: "cpu", specs: { bench: { tokens_per_second_avg: 4 } } };
const fastGpu = { id: "gpu2", specs: { bench: { tokens_per_second_avg: 60 } } };
const job = (over = {}) => ({ type: "chat", status: "assigned", provider_id: "gpu", input_spec: {}, ...over });

describe("requeueDecision: a turned-away job goes back to the front", () => {
    it("goes to the first capable node with a free slot, a CPU node included", () => {
        expect(requeueDecision({ job: job(), tokens: 0, provider: gpu, target: cpu }))
            .toEqual({ requeue: true, reason: "moved_to_free_node", to: "cpu", moved: true });
        expect(requeueDecision({ job: job(), tokens: 0, provider: gpu, target: fastGpu }))
            .toMatchObject({ requeue: true, to: "gpu2", moved: true });
    });

    it("with no node free, stays first in line on its node", () => {
        expect(requeueDecision({ job: job(), tokens: 0, provider: gpu, target: null }))
            .toEqual({ requeue: true, reason: "front_of_queue", to: "gpu", moved: false });
    });

    it("never requeues an answer that started, a finished job or someone else's", () => {
        expect(requeueDecision({ job: job(), tokens: 3, provider: gpu }).requeue).toBe(false);
        expect(requeueDecision({ job: job({ status: "completed" }), tokens: 0, provider: gpu }).requeue).toBe(false);
        expect(requeueDecision({ job: job({ provider_id: "other" }), tokens: 0, provider: gpu }).requeue).toBe(false);
        expect(requeueDecision({ job: job({ type: "training" }), tokens: 0, provider: gpu }).requeue).toBe(false);
    });

    it("stops after MAX_REQUEUES so a broken node cannot bounce a job forever", () => {
        const d = requeueDecision({ job: job({ input_spec: { requeues: MAX_REQUEUES } }), tokens: 0, provider: gpu });
        expect(d).toMatchObject({ requeue: false, reason: "too_many_requeues" });
    });

    it("keeps reservation, E2E and batch jobs on their node", () => {
        for (const pin of [{ reservation_id: "r" }, { client_pubkey: "ab" }, { batch_item_id: "b" }]) {
            expect(requeueDecision({ job: job(pin), tokens: 0, provider: gpu, target: fastGpu }).to).toBe("gpu");
        }
    });
});

describe("turn-away errors (CLI and control plane agree)", () => {
    const busy = [
        "daemon restarting for self-update",
        "ollama HTTP 503: server busy, please try again.  maximum pending requests exceeded",
        "ollama HTTP 429: too many requests",
        "fetch failed",
        "connect ECONNREFUSED 127.0.0.1:11434",
        "no inference engine reachable on this node (Ollama/vLLM/llama.cpp did not answer); refusing to serve stub output"
    ];
    const broken = ['ollama HTTP 404: model "ghost:7b" not found', "Failed to decrypt E2E messages", "engine error"];
    it("busy", () => {
        for (const m of busy) {
            expect(isTurnAwayError(m), m).toBe(true);
            expect(cliIsTurnAway(m), m).toBe(true);
        }
    });
    it("not busy", () => {
        for (const m of broken) {
            expect(isTurnAwayError(m), m).toBe(false);
            expect(cliIsTurnAway(m), m).toBe(false);
        }
    });
});

describe("requeueTurnedAway (daemon)", () => {
    it("true only when the control plane requeued it", async () => {
        expect(await requeueTurnedAway({ requeueJob: async () => ({ data: { requeued: true } }) }, "j", "busy")).toBe(true);
        expect(await requeueTurnedAway({ requeueJob: async () => ({ data: { requeued: false, reason: "answer_started" } }) }, "j", "busy")).toBe(false);
        // An older control plane without the endpoint: fail as before.
        expect(await requeueTurnedAway({ requeueJob: async () => { throw new Error("HTTP 404"); } }, "j", "busy")).toBe(false);
        expect(await requeueTurnedAway({}, "j", "busy")).toBe(false);
    });
});
