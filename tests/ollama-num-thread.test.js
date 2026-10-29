import { describe, expect, it, beforeEach, afterEach } from "vitest";
import os from "node:os";

import { createOllamaBackend, defaultNumThread } from "../packages/engine/src/backends/ollama.js";

describe("Ollama backend — default num_thread cap", () => {
    it("defaults to half of logical cores, floored at 1", () => {
        const want = Math.max(1, Math.floor(os.cpus().length / 2));
        expect(defaultNumThread()).toBe(want);
    });

    it("createOllamaBackend exposes the resolved numThread", async () => {
        const engine = await createOllamaBackend({ skipProbe: true, fetchImpl: async () => null });
        expect(engine.numThread).toBe(defaultNumThread());
    });

    it("env OLLAMA_NUM_THREAD overrides the default", async () => {
        const before = process.env.OLLAMA_NUM_THREAD;
        process.env.OLLAMA_NUM_THREAD = "3";
        try {
            const engine = await createOllamaBackend({ skipProbe: true, fetchImpl: async () => null });
            expect(engine.numThread).toBe(3);
        } finally {
            if (before === undefined) delete process.env.OLLAMA_NUM_THREAD;
            else process.env.OLLAMA_NUM_THREAD = before;
        }
    });

    it("explicit numThread option wins over env + default", async () => {
        const before = process.env.OLLAMA_NUM_THREAD;
        process.env.OLLAMA_NUM_THREAD = "3";
        try {
            const engine = await createOllamaBackend({
                skipProbe: true,
                fetchImpl: async () => null,
                numThread: 7
            });
            expect(engine.numThread).toBe(7);
        } finally {
            if (before === undefined) delete process.env.OLLAMA_NUM_THREAD;
            else process.env.OLLAMA_NUM_THREAD = before;
        }
    });

    it("generate() POSTs num_thread in body.options", async () => {
        let captured = null;
        const fetchImpl = async (url, init) => {
            captured = JSON.parse(init.body);
            // Return a closing 'done' frame so the stream resolves cleanly.
            return {
                ok: true,
                body: {
                    getReader: () => ({
                        read: async () => ({ done: true, value: undefined }),
                        cancel: async () => {}
                    })
                }
            };
        };
        const engine = await createOllamaBackend({
            skipProbe: true,
            numThread: 5,
            fetchImpl
        });
        const gen = engine.generate({
            model: "qwen2.5:0.5b",
            messages: [{ role: "user", content: "hi" }]
        });
        // Drain the stream.
        for await (const _ of gen.stream) { /* noop */ }
        expect(captured?.options?.num_thread).toBe(5);
    });

    it("disables private reasoning so the answer fits the output stream", async () => {
        let captured = null;
        const fetchImpl = async (_url, init) => {
            captured = JSON.parse(init.body);
            return {
                ok: true,
                body: {
                    getReader: () => ({
                        read: async () => ({ done: true, value: undefined }),
                        cancel: async () => {}
                    })
                }
            };
        };
        const engine = await createOllamaBackend({ skipProbe: true, fetchImpl });
        const gen = engine.generate({ model: "qwen3.5:2b", messages: [] });
        for await (const _ of gen.stream) { /* noop */ }
        expect(captured?.think).toBe(false);
    });
});
