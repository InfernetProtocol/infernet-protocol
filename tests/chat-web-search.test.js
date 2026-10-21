import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { buildWebContext, pageToText, TRON_MCP_URL } = await import("@/lib/web-search");

function fakeFetch({ results, pages, searchStatus = 200 }) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push([String(url), init]);
        if (String(url).startsWith("https://api.valueserp.com/")) {
            return new Response(JSON.stringify({ organic_results: results }), { status: searchStatus });
        }
        if (String(url) === TRON_MCP_URL) {
            const target = JSON.parse(init.body).params.arguments.url;
            const page = pages[target];
            if (page === undefined) return new Response("rate limited", { status: 429 });
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: page }] } }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
    };
    return { impl, calls };
}

describe("web search for chat", () => {
    const results = [
        { title: "Alpha", link: "https://a.example/x", snippet: "alpha snippet" },
        { title: "Beta", link: "https://b.example/y", snippet: "beta snippet" },
        { title: "Gamma", link: "https://c.example/z", snippet: "gamma snippet" },
        { title: "Delta", link: "https://d.example/w", snippet: "delta snippet" },
        { title: "no link" },
        { title: "Ftp", link: "ftp://e.example" }
    ];

    it("searches, reads the top 3 pages through tron, and numbers the sources", async () => {
        const { impl, calls } = fakeFetch({
            results,
            pages: {
                "https://a.example/x": "# Alpha page\n\n![img](x.png) Alpha body with a [link](https://z).",
                "https://b.example/y": "Beta body."
                // c.example: relay 429 -> falls back to the snippet
            }
        });
        const out = await buildWebContext("what is alpha", { fetchImpl: impl, apiKey: "k", now: new Date("2026-10-21T00:00:00Z") });

        expect(out.sources.map((s) => [s.n, s.url, s.read])).toEqual([
            [1, "https://a.example/x", true],
            [2, "https://b.example/y", true],
            [3, "https://c.example/z", false],
            [4, "https://d.example/w", false]
        ]);
        expect(out.context).toContain('Web search results for "what is alpha", retrieved 2026-10-21.');
        expect(out.context).toContain("[1] Alpha\nhttps://a.example/x\nAlpha page Alpha body with a link.");
        expect(out.context).toContain("[3] Gamma\nhttps://c.example/z\ngamma snippet");
        expect(out.context).toContain("Cite them inline as [1], [2]");
        // Page bodies stay server-side; the browser only gets the citation list.
        expect(out.sources[0]).not.toHaveProperty("text");
        // One search + exactly three page reads, as MCP tools/call fetch_page.
        expect(calls.filter(([u]) => u === TRON_MCP_URL)).toHaveLength(3);
        const body = JSON.parse(calls.find(([u]) => u === TRON_MCP_URL)[1].body);
        expect(body).toMatchObject({ method: "tools/call", params: { name: "fetch_page" } });
    });

    it("says so when the search finds nothing", async () => {
        const { impl } = fakeFetch({ results: [], pages: {} });
        const out = await buildWebContext("zzqx", { fetchImpl: impl, apiKey: "k" });
        expect(out.sources).toEqual([]);
        expect(out.context).toMatch(/found nothing/);
    });

    it("fails clearly without a key or when the provider errors", async () => {
        await expect(buildWebContext("q", { fetchImpl: fakeFetch({ results }).impl, apiKey: "" })).rejects.toThrow(/not configured/);
        await expect(buildWebContext("q", { fetchImpl: fakeFetch({ results, pages: {}, searchStatus: 500 }).impl, apiKey: "k" }))
            .rejects.toThrow(/500/);
    });

    it("keeps the words of a markdown page and drops images and link targets", () => {
        expect(pageToText("## Title\n![a](b.png) see [docs](https://x) **now**").replace(/\s+/g, " ").trim())
            .toBe("Title see docs now");
    });
});
