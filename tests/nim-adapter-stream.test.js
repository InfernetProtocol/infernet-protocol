import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamChatCompletion, nimVirtualProvider, fallbackName } from "../packages/nim-adapter/src/index.js";

// Cloudflare Workers AI (used as the hosted fallback) streams a token that is
// a bare number as a JSON number: {"delta":{"content":1}}. A string-only check
// dropped every digit from the answer.
function sse(frames) {
    const body = frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
}

beforeEach(() => { process.env.NVIDIA_NIM_API_KEY = "k"; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.NVIDIA_NIM_API_KEY; delete process.env.HOSTED_FALLBACK_NAME; });

describe("nim adapter stream", () => {
    it("keeps numeric tokens", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => sse([
            { choices: [{ delta: { content: "", role: "assistant" } }] },
            { choices: [{ delta: { content: 1 } }] },
            { choices: [{ delta: { content: ", " } }] },
            { choices: [{ delta: { content: 2 } }] },
            "[DONE]"
        ])));
        const events = [];
        for await (const ev of streamChatCompletion({ messages: [{ role: "user", content: "count" }] })) events.push(ev);
        expect(events.at(-1)).toMatchObject({ type: "done", data: { text: "1, 2" } });
    });

    it("the provider name users see is configurable", () => {
        expect(fallbackName()).toBe("NVIDIA NIM (fallback)");
        process.env.HOSTED_FALLBACK_NAME = "Cloudflare Workers AI (fallback)";
        expect(nimVirtualProvider().name).toBe("Cloudflare Workers AI (fallback)");
    });
});
