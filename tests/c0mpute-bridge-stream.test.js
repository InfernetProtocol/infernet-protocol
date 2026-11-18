import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/model-names", () => ({ matchServedModel: (list, m) => (list.includes(m) ? m : null) }));
const c0 = await import("../apps/web/lib/chat/c0mpute-inference.js");

// c0mpute >= 0.3.85: POST /v1/jobs with "stream": true answers NDJSON
// (queued / running lines, then result or error). Infernet forwards the
// progress as the `status` events moshcode renders.
const env = { C0MPUTE_JOBS_URL: "http://bridge:8788", C0MPUTE_JOBS_TOKEN: "t" };
const messages = [{ role: "user", content: "hi" }];

function ndjsonFetch(lines, captured = {}) {
    return async (url, init) => {
        captured.body = JSON.parse(init.body);
        captured.accept = init.headers.accept;
        for (const l of lines) init.onLine?.(JSON.stringify(l));
        const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
        return { ok: true, status: 200, contentType: "application/x-ndjson", text: async () => text, json: async () => { throw new Error("ndjson"); } };
    };
}

describe("bridgeProgress", () => {
    it("queued -> stage waiting with position and try n of 3", () => {
        const p = c0.bridgeProgress({ event: "queued", position: 2, queue_length: 4, status: "waiting for a free inference slot (GPU or CPU)", requeues: 1, waited_ms: 5000 });
        expect(p).toMatchObject({ state: "waiting", stage: "waiting", queue_position: 1, queue_length: 4, requeues: 1, try: 2, max_requeues: 3 });
        expect(p.message).toBe("waiting for a free inference slot (GPU or CPU) (position 2 of 4, try 2 of 3)");
    });
    it("running -> stage running with the ETA", () => {
        expect(c0.bridgeProgress({ event: "running", worker: "12D3W", eta_s: 12 })).toMatchObject({ stage: "running", worker: "12D3W", eta_s: 12 });
        expect(c0.bridgeProgress({ event: "result" })).toBeNull();
    });
});

describe("runC0mputeChat with a streaming bridge", () => {
    it("asks for the stream and passes progress on, then reads the result line", async () => {
        const captured = {};
        const progress = [];
        const fetchImpl = ndjsonFetch([
            { event: "queued", position: 1, queue_length: 1, status: "waiting for a free inference slot (GPU or CPU)", requeues: 0 },
            { event: "running", job_id: "cj", worker: "12D3W", eta_s: 8 },
            { event: "result", status: 200, body: { result: { ok: true, text: "hello", model: "m" }, worker: "12D3W", job_id: "cj", price: 0.001 } }
        ], captured);
        const out = await c0.runC0mputeChat({ model: "m", messages, onProgress: (p) => progress.push(p) }, { fetchImpl, env });
        expect(captured.body.stream).toBe(true);
        expect(captured.accept).toMatch(/application\/x-ndjson/);
        expect(progress.map((p) => p.stage)).toEqual(["waiting", "running"]);
        expect(out).toMatchObject({ ok: true, text: "hello", worker: "12D3W", jobId: "cj" });
    });

    it("an error line carries the real status; network_busy keeps the exact message", async () => {
        const fetchImpl = ndjsonFetch([
            { event: "queued", position: 1, queue_length: 1, requeues: 2 },
            { event: "error", status: 503, body: { error: "network_busy", detail: "Network is busy. Run a node or wait. (c0mpute.com/getting-started)", requeues: 3 } }
        ]);
        const out = await c0.runC0mputeChat({ model: "m", messages }, { fetchImpl, env });
        expect(out).toMatchObject({ ok: false, code: "network_busy", status: 503, error: "Network is busy. Run a node or wait." });
    });

    it("an older bridge answering plain JSON still works", async () => {
        const fetchImpl = async () => ({ ok: true, status: 200, contentType: "application/json", json: async () => ({ result: { ok: true, text: "x" }, worker: "w", job_id: "j" }) });
        expect(await c0.runC0mputeChat({ model: "m", messages }, { fetchImpl, env })).toMatchObject({ ok: true, text: "x" });
    });
});

describe("c0mputeJobEvents forwards the bridge's progress", () => {
    const job = { id: "job-1", model_name: "m", input_spec: { messages, fallback: "c0mpute", c0mpute_model: "m" } };
    const deps = () => {
        const events = [];
        return {
            events,
            insertEvent: async (_id, type, data) => { events.push(type); return { id: events.length, data }; },
            finalize: async () => {}, charge: async () => {}, log: () => {},
            queue: c0.createWaitQueue(), sleep: async () => {}
        };
    };

    it("status events while the bridge waits, then the answer", async () => {
        const run = async ({ onProgress }) => {
            onProgress(c0.bridgeProgress({ event: "queued", position: 3, queue_length: 3, requeues: 0 }));
            await new Promise((r) => setTimeout(r, 5));
            onProgress(c0.bridgeProgress({ event: "running", worker: "W", eta_s: 9 }));
            return { ok: true, text: "hi", model: "m", worker: "W", jobId: "cj", price: 0, durationMs: 1 };
        };
        const d = deps();
        const out = [];
        for await (const ev of c0.c0mputeJobEvents(job, { ...d, run, serves: async () => true })) out.push(ev);
        expect(out.map((e) => e.type)).toEqual(["meta", "status", "status", "token", "done"]);
        expect(out[1].data).toMatchObject({ stage: "waiting", queue_position: 2, try: 1 });
        expect(out[2].data).toMatchObject({ stage: "running", worker: "W" });
        expect(d.events).toEqual(["meta", "status", "status", "token", "done"]);
    });

    it("bridge gave up (network_busy): a free daemon takes it, else the job ends with the message, no extra tries", async () => {
        const busy = { ok: false, code: "network_busy", error: "Network is busy. Run a node or wait." };
        const run1 = vi.fn(async () => busy);
        const out1 = [];
        for await (const ev of c0.c0mputeJobEvents(job, { ...deps(), run: run1, serves: async () => true })) out1.push(ev);
        expect(run1).toHaveBeenCalledTimes(1);
        expect(out1.at(-1)).toMatchObject({ type: "c0mpute_failed", data: { final: true, code: "network_busy", message: "Network is busy. Run a node or wait." } });

        const out2 = [];
        const assign = async ({ freeSlot }) => (freeSlot ? { ...job, provider_id: "cpu" } : null);
        for await (const ev of c0.c0mputeJobEvents(job, { ...deps(), run: async () => busy, assign, serves: async () => true })) out2.push(ev);
        expect(out2.at(-1)).toMatchObject({ type: "assigned" });
    });

    it("bridge says no node serves the model: no requeue, a daemon serving it or a clear failure", async () => {
        const run = vi.fn(async () => ({ ok: false, code: "no_capable_node", error: "no node serves this model" }));
        const out = [];
        for await (const ev of c0.c0mputeJobEvents(job, { ...deps(), run, serves: async () => true })) out.push(ev);
        expect(run).toHaveBeenCalledTimes(1);
        expect(out.at(-1).data).toMatchObject({ final: true, code: "no_capable_node", message: "No node serves m." });
    });
});
