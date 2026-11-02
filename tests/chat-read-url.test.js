import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { findDocumentUrls } = await import("@/lib/doc-urls");
const { readDocument, fitText, documentContext, ReadError } = await import("@/lib/read-url");

describe("finding links to read", () => {
    it("finds the link in a summarize request", () => {
        expect(findDocumentUrls("can you summarize this for me in both technical and layman terms? https://arxiv.org/pdf/2106.01820"))
            .toEqual(["https://arxiv.org/pdf/2106.01820"]);
    });
    it("strips trailing punctuation, dedupes, caps at two, ignores other schemes", () => {
        expect(findDocumentUrls("see (https://a.example/x.pdf), https://a.example/x.pdf and https://b.example/y. ftp://c.example/z https://c.example/w"))
            .toEqual(["https://a.example/x.pdf", "https://b.example/y"]);
        expect(findDocumentUrls("https://en.wikipedia.org/wiki/Bus_(computing) please")).toEqual(["https://en.wikipedia.org/wiki/Bus_(computing)"]);
        expect(findDocumentUrls("no links here")).toEqual([]);
    });
});

describe("reading through readm3", () => {
    it("posts the URL to readm3 and returns the document", async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push([String(url), JSON.parse(init.body)]);
            return new Response(JSON.stringify({ title: "Intuition in Einsteinian Physics", kind: "pdf", pages: 17, chars: 40154, text: "Abstract ..." }), { status: 200 });
        };
        const doc = await readDocument("https://arxiv.org/pdf/2106.01820", { fetchImpl });
        expect(doc.pages).toBe(17);
        expect(calls[0][0]).toBe("https://readm3.com/api/v1/read");
        expect(calls[0][1].url).toBe("https://arxiv.org/pdf/2106.01820");
    });
    it("turns readm3's 402 into a plain limit message", async () => {
        const fetchImpl = async () => new Response(JSON.stringify({ error: "pay" }), { status: 402 });
        await expect(readDocument("https://x.example/a.pdf", { fetchImpl })).rejects.toBeInstanceOf(ReadError);
        await expect(readDocument("https://x.example/a.pdf", { fetchImpl })).rejects.toThrow("allowance");
    });
    it("passes readm3's own refusal through", async () => {
        const fetchImpl = async () => new Response(JSON.stringify({ error: "Only public addresses are read." }), { status: 400 });
        await expect(readDocument("http://10.0.0.1/", { fetchImpl })).rejects.toThrow("public addresses");
    });
});

describe("fitting a document into a small model", () => {
    it("keeps short documents whole", () => {
        expect(fitText("short text", 5000)).toEqual({ text: "short text", omitted: 0 });
    });
    it("keeps the start and the end of a long one, within budget", () => {
        const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} of the paper with some words`);
        const { text, omitted } = fitText(lines.join("\n"), 7000);
        expect(omitted).toBeGreaterThan(0);
        expect(text).toContain("line 0 of the paper");
        expect(text).toContain("line 1999 of the paper");
        expect(text).toContain("left out");
        expect(text.length).toBeLessThan(7200);
    });
    it("builds a system message that names the source and asks for a faithful answer", () => {
        const ctx = documentContext({ url: "https://arxiv.org/pdf/2106.01820", finalUrl: "https://arxiv.org/pdf/2106.01820", title: "Intuition in Einsteinian Physics", kind: "pdf", pages: 17, chars: 40154, text: "Abstract: intuition matters." });
        expect(ctx).toContain("BEGIN DOCUMENT: Intuition in Einsteinian Physics");
        expect(ctx).toContain("PDF, 17 pages");
        expect(ctx).toContain("Abstract: intuition matters.");
        expect(ctx).toContain("Do not invent");
    });
});
