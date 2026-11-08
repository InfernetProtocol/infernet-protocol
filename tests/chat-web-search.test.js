import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { buildWebContext, pageToText, usablePageText, TRON_MCP_URL } = await import("@/lib/web-search");

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
        { title: "Beta", link: "https://b.example/y", snippet: "alpha beta snippet" },
        { title: "Gamma", link: "https://c.example/z", snippet: "alpha gamma snippet" },
        { title: "Delta", link: "https://d.example/w", snippet: "alpha delta snippet" },
        { title: "no link" },
        { title: "Ftp", link: "ftp://e.example" }
    ];

    it("searches, reads the top 3 pages through tron, and numbers the sources", async () => {
        const { impl, calls } = fakeFetch({
            results,
            pages: {
                "https://a.example/x": "Skip to content\nDocs\n# Alpha page\n\n![img](x.png) Alpha 2.0 shipped on 2026-10-01 with a [new engine](https://z).",
                "https://b.example/y": "Menu\nBeta is a long enough line of real content to keep."
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
        // Snippet first (it carries the date), then the page text without its navigation lines.
        expect(out.context).toContain("[1] Alpha\nhttps://a.example/x\nalpha snippet\nAlpha 2.0 shipped on 2026-10-01 with a new engine.");
        expect(out.context).not.toContain("Skip to content");
        expect(out.context).toContain("[3] Gamma\nhttps://c.example/z\nalpha gamma snippet");
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

    it("keeps the words of a markdown page and drops images, link targets and short nav lines", () => {
        expect(pageToText("## Title\nHome\n![a](b.png) see the [docs](https://x) for **everything** you need here"))
            .toBe("see the docs for everything you need here");
    });

    it("drops bot-check pages and the relay's JSON status line", () => {
        const npmWall = "This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.\n{\"engine\":\"chromium\",\"url\":\"https://www.npmjs.com/package/node\",\"ms\":2030}";
        expect(usablePageText(npmWall)).toBe("");
        expect(usablePageText("A long enough paragraph of real article content goes here.\n{\"engine\":\"obscura\",\"ms\":12,\"chars\":900}"))
            .toBe("A long enough paragraph of real article content goes here.");
    });

    it("asks Google for English results", async () => {
        const { impl, calls } = fakeFetch({ results: [], pages: {} });
        await buildWebContext("q", { fetchImpl: impl, apiKey: "k" });
        const url = new URL(calls[0][0]);
        expect([url.searchParams.get("hl"), url.searchParams.get("gl")]).toEqual(["en", "us"]);
    });

    it("quotes distinctive terms and filters generic results that miss them", async () => {
        const candidates = [
            { title: "Command line interface tips", link: "https://generic.example/cli", snippet: "Latest command line features and version news." },
            { title: "Infernet CLI release v0.1.89", link: "https://infernetprotocol.com/cli", snippet: "The latest Infernet CLI is version 0.1.89." },
            { title: "Infernet API", link: "https://infernetprotocol.com/api", snippet: "API quickstart and SDK documentation." }
        ];
        const { impl, calls } = fakeFetch({ results: candidates, pages: {} });
        const out = await buildWebContext("What is the latest version of the Infernet CLI?", { fetchImpl: impl, apiKey: "k" });
        const search = new URL(calls[0][0]);
        expect(search.searchParams.get("q")).toContain('"infernet"');
        expect(search.searchParams.get("q")).toContain('"cli"');
        expect(out.sources.map((source) => source.title)).toEqual(["Infernet CLI release v0.1.89"]);
        expect(out.context).toContain("Infernet CLI release v0.1.89");
        expect(out.context).not.toContain("Command line interface tips");
    });
});

describe("tron relay budget and flagged pages", async () => {
    const { fetchPageText, PageFlaggedError, PAGE_TIMEOUT_MS, RELAY_RENDER_S } = await import("@/lib/web-search");

    it("gives the relay its 30 s render plus overhead", () => {
        expect(RELAY_RENDER_S).toBe(30);
        expect(PAGE_TIMEOUT_MS).toBe(35_000);
        expect(PAGE_TIMEOUT_MS).toBeGreaterThan(RELAY_RENDER_S * 1000);
    });

    it("asks for the 30 s budget and turns a FLAGGED answer into PageFlaggedError at once", async () => {
        const sent = [];
        const impl = async (_url, init) => {
            sent.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Error: FLAGGED until 2026-12-08T00:00:00.000Z: host dead.example failed (connection: net::ERR_NAME_NOT_RESOLVED) at 2026-11-08T00:00:00.000Z; not fetched again before then" }] } }), { status: 200 });
        };
        const err = await fetchPageText("https://dead.example/", { fetchImpl: impl }).catch((e) => e);
        expect(err).toBeInstanceOf(PageFlaggedError);
        expect(err.until).toBe("2026-12-08T00:00:00.000Z");
        expect(sent).toHaveLength(1);
        expect(sent[0].params.arguments).toMatchObject({ url: "https://dead.example/", timeout_s: 30 });
    });

    it("other tool errors stay plain errors with the relay's text", async () => {
        const impl = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "Error: Busy: 3 pages are rendering." }] } }), { status: 200 });
        const err = await fetchPageText("https://x.example/", { fetchImpl: impl }).catch((e) => e);
        expect(err).not.toBeInstanceOf(PageFlaggedError);
        expect(err.message).toMatch(/Busy/);
    });
});
