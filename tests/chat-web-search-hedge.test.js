import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { searchWeb, SearchTimeoutError } = await import("@/lib/web-search");

const OK = { organic_results: [{ title: "T", link: "https://example.com/", snippet: "s" }] };

/** fetch whose nth call answers after delays[n] ms with statuses[n] (default 200). */
function scripted(delays, statuses = []) {
    const calls = [];
    const impl = (url, init) => {
        const n = calls.length;
        calls.push({ url: String(url), signal: init.signal });
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve(new Response(JSON.stringify(OK), { status: statuses[n] ?? 200 })), delays[n] ?? 0);
            init.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
        });
    };
    return { impl, calls };
}

const opts = (impl) => ({ apiKey: "k", fetchImpl: impl, hedgeMs: 30, timeoutMs: 200 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("searchWeb hedging", () => {
    it("answers from the first request when it is fast, without a hedge", async () => {
        const f = scripted([5]);
        await expect(searchWeb("q", opts(f.impl))).resolves.toHaveLength(1);
        await wait(50);
        expect(f.calls).toHaveLength(1);
    });

    it("sends a hedge when the first is slow and takes the faster answer", async () => {
        const f = scripted([150, 10]);
        const t0 = Date.now();
        await expect(searchWeb("q", opts(f.impl))).resolves.toHaveLength(1);
        expect(Date.now() - t0).toBeLessThan(120);
        expect(f.calls).toHaveLength(2);
        expect(f.calls[0].signal.aborted).toBe(true);
    });

    it("rejects with SearchTimeoutError when neither answers in time", async () => {
        const f = scripted([1000, 1000]);
        await expect(searchWeb("q", opts(f.impl))).rejects.toBeInstanceOf(SearchTimeoutError);
        expect(f.calls).toHaveLength(2);
    });

    it("does not retry a 4xx", async () => {
        const f = scripted([1], [401]);
        await expect(searchWeb("q", opts(f.impl))).rejects.toThrow("returned 401");
        await wait(50);
        expect(f.calls).toHaveLength(1);
    });

    it("retries a 5xx at once and never sends a third request", async () => {
        const f = scripted([1, 5], [503, 200]);
        await expect(searchWeb("q", opts(f.impl))).resolves.toHaveLength(1);
        await wait(60);
        expect(f.calls).toHaveLength(2);
    });

    it("rejects with the last error when both attempts fail", async () => {
        const f = scripted([1, 1], [502, 503]);
        await expect(searchWeb("q", opts(f.impl))).rejects.toThrow("returned 503");
    });
});
