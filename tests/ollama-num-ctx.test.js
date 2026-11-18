import { describe, expect, it } from "vitest";

import {
    createOllamaBackend,
    parseNumCtx,
    cappedNumCtx,
    resolveMaxCtx,
    DEFAULT_MAX_CTX
} from "../packages/engine/src/backends/ollama.js";

// 2026-11-18: eriktonon/qwen3.8-uncensored:9b ships num_ctx 65536; Ollama
// sized it at 13.6 GiB and thrashed a 12 GB GPU. Requests now cap the context.

function fakeOllama({ parameters, showOk = true } = {}) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const u = String(url);
        const body = JSON.parse(init.body);
        calls.push({ path: new URL(u).pathname, body });
        if (u.endsWith("/api/show")) {
            return { ok: showOk, status: showOk ? 200 : 404, text: async () => JSON.stringify({ parameters }) };
        }
        return {
            ok: true,
            status: 200,
            body: (async function* () {
                yield Buffer.from(JSON.stringify({ model: body.model, message: { content: "hi" }, done: true }) + "\n");
            })()
        };
    };
    return { calls, fetchImpl };
}

async function run(engine, model = "eriktonon/qwen3.8-uncensored:9b") {
    const gen = engine.generate({ model, messages: [{ role: "user", content: "hi" }] });
    for await (const _ of gen.stream) { /* drain */ }
}

describe("Ollama backend: num_ctx cap", () => {
    it("parses num_ctx out of /api/show parameters", () => {
        expect(parseNumCtx("num_ctx                        65536\nstop \"<|im_end|>\"")).toBe(65536);
        expect(parseNumCtx("stop \"x\"\ntemperature 0.7")).toBeNull();
        expect(parseNumCtx(undefined)).toBeNull();
    });

    it("caps only models above the cap", () => {
        expect(cappedNumCtx(65536, 32768)).toBe(32768);
        expect(cappedNumCtx(32768, 32768)).toBeNull();
        expect(cappedNumCtx(4096, 32768)).toBeNull();
        expect(cappedNumCtx(null, 32768)).toBeNull();
        expect(cappedNumCtx(65536, 0)).toBeNull();
    });

    it("defaults to 32768; INFERNET_OLLAMA_MAX_CTX overrides, 0 disables", () => {
        expect(DEFAULT_MAX_CTX).toBe(32768);
        expect(resolveMaxCtx(undefined)).toBe(32768);
        expect(resolveMaxCtx("")).toBe(32768);
        expect(resolveMaxCtx("16384")).toBe(16384);
        expect(resolveMaxCtx("0")).toBe(0);
        expect(resolveMaxCtx("junk")).toBe(32768);
    });

    it("sends options.num_ctx = cap for a 64K Modelfile, looking it up once", async () => {
        const { calls, fetchImpl } = fakeOllama({ parameters: "num_ctx 65536" });
        const engine = await createOllamaBackend({ skipProbe: true, fetchImpl, maxCtx: 32768 });
        await run(engine);
        await run(engine);
        const chats = calls.filter((c) => c.path === "/api/chat");
        expect(chats).toHaveLength(2);
        for (const c of chats) expect(c.body.options.num_ctx).toBe(32768);
        expect(calls.filter((c) => c.path === "/api/show")).toHaveLength(1);
    });

    it("leaves a small-context model alone", async () => {
        const { calls, fetchImpl } = fakeOllama({ parameters: "num_ctx 4096" });
        const engine = await createOllamaBackend({ skipProbe: true, fetchImpl, maxCtx: 32768 });
        await run(engine, "qwen3:4b");
        expect(calls.find((c) => c.path === "/api/chat").body.options.num_ctx).toBeUndefined();
    });

    it("still answers when /api/show fails", async () => {
        const { calls, fetchImpl } = fakeOllama({ showOk: false });
        const engine = await createOllamaBackend({ skipProbe: true, fetchImpl, maxCtx: 32768 });
        await run(engine);
        expect(calls.find((c) => c.path === "/api/chat").body.options.num_ctx).toBeUndefined();
    });

    it("skips the lookup entirely when the cap is off", async () => {
        const { calls, fetchImpl } = fakeOllama({ parameters: "num_ctx 65536" });
        const engine = await createOllamaBackend({ skipProbe: true, fetchImpl, maxCtx: 0 });
        await run(engine);
        expect(calls.map((c) => c.path)).toEqual(["/api/chat"]);
    });
});
