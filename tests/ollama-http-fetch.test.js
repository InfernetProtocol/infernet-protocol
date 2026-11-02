import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";

import { createOllamaBackend, ollamaHttpFetch } from "../packages/engine/src/backends/ollama.js";

// A fake Ollama: /api/chat waits `delayMs` before sending headers (as a busy
// single-GPU daemon does while a request sits in its queue), then streams
// NDJSON frames.
function fakeOllama({ delayMs = 0, frames = [] } = {}) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            seen.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
            const timer = setTimeout(() => {
                res.writeHead(200, { "content-type": "application/x-ndjson" });
                for (const f of frames) res.write(JSON.stringify(f) + "\n");
                res.end();
            }, delayMs);
            res.on("close", () => clearTimeout(timer));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({ host: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) });
        });
    });
}

let fake;
afterEach(async () => {
    if (fake) await fake.close();
    fake = null;
});

describe("ollamaHttpFetch (no transport timeout for queued /api/chat)", () => {
    it("POSTs the body and exposes ok/status/async-iterable body", async () => {
        fake = await fakeOllama({ frames: [{ message: { content: "hi" }, done: true }] });
        const res = await ollamaHttpFetch(new URL("/api/chat", fake.host), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "m" })
        });
        expect(res.ok).toBe(true);
        expect(res.status).toBe(200);
        let text = "";
        for await (const chunk of res.body) text += chunk;
        expect(JSON.parse(text.trim()).message.content).toBe("hi");
        expect(fake.seen[0]).toMatchObject({ url: "/api/chat", method: "POST", body: { model: "m" } });
    });

    it("rejects with AbortError when the signal aborts while waiting for headers", async () => {
        fake = await fakeOllama({ delayMs: 10_000 });
        const ctrl = new AbortController();
        const p = ollamaHttpFetch(new URL("/api/chat", fake.host), { method: "POST", body: "{}", signal: ctrl.signal });
        setTimeout(() => ctrl.abort(), 50);
        await expect(p).rejects.toMatchObject({ name: "AbortError" });
    });
});

describe("Ollama backend over the default transport", () => {
    it("streams tokens to done after a slow first byte", async () => {
        fake = await fakeOllama({
            delayMs: 300,
            frames: [
                { model: "qwen3:4b", message: { content: "Hel" }, done: false },
                { message: { content: "lo" }, done: false },
                { message: { content: "" }, done: true, done_reason: "stop" }
            ]
        });
        const engine = await createOllamaBackend({ host: fake.host, skipProbe: true });
        const gen = engine.generate({ model: "qwen3:4b", messages: [{ role: "user", content: "hi" }] });
        const events = [];
        for await (const ev of gen.stream) events.push(ev);
        expect(events.filter((e) => e.type === "token").map((e) => e.text).join("")).toBe("Hello");
        expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", text: "Hello" });
    });

    it("cancel() while queued ends with a cancel done, not an error", async () => {
        fake = await fakeOllama({ delayMs: 10_000 });
        const engine = await createOllamaBackend({ host: fake.host, skipProbe: true });
        const gen = engine.generate({ model: "qwen3:4b", messages: [] });
        setTimeout(() => gen.cancel(), 50);
        const events = [];
        for await (const ev of gen.stream) events.push(ev);
        expect(events.at(-1)).toMatchObject({ type: "done", reason: "cancel" });
    });
});
