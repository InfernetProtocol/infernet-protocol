import { describe, expect, it } from "vitest";

const { extractColors, readHtml, buildBrief, isPrivateAddress, lookupSiteRecord, submitToPitWorld } = await import("@/lib/site-brief");
const { brandImagePrompt, brandContext, colorName } = await import("@/lib/brand-prompt");
const { MAX_IMAGE_PROMPT_CHARS } = await import("@/lib/billing/image");

const RECORD = {
    url: "https://profullstack.com/",
    site: { web: "https://profullstack.com", name: "Profullstack" },
    title: "Profullstack, Inc. | Agentic Engineering",
    description: "Profullstack is an agentic engineering firm.",
    tags: ["agents", "engineering"],
    image: { url: "https://profullstack.com/assets/og/og.png" },
    feeds: ["https://profullstack.com/blog/feed.xml"],
    jsonld: [{ "@type": "Organization", name: "Profullstack, Inc.", slogan: "Agentic Engineering", logo: "https://profullstack.com/logo-black.png", knowsAbout: ["Agentic engineering", "AI coding agents"] }]
};

const HTML = `<!doctype html><html><head><title>Acme Rockets – Fast rockets</title>
<meta name="theme-color" content="#0b1220">
<meta property="og:site_name" content="Acme Rockets">
<meta name="description" content="Rockets for everyone &amp; their dogs.">
<link rel="icon" href="/favicon.png"><link rel="stylesheet" href="/site.css">
<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"Acme","slogan":"Up we go"}]}</script>
<style>:root{--brand-primary:#ff6600;--accent:#14b8a6;--bg:#0b1220;--fg:#ffffff} a{color:#ff6600} body{background:#0b1220}</style>
</head><body></body></html>`;

describe("reading a page", () => {
    it("reads meta, links, JSON-LD and inline CSS", () => {
        const page = readHtml(HTML, "https://acme.example/");
        expect(page.meta["theme-color"]).toBe("#0b1220");
        expect(page.meta.description).toBe("Rockets for everyone & their dogs.");
        expect(page.links.find((l) => l.rel === "stylesheet").href).toBe("https://acme.example/site.css");
        expect(page.jsonld[0].slogan).toBe("Up we go");
    });
    it("ranks brand custom properties first and finds a dark scheme", () => {
        const page = readHtml(HTML, "https://acme.example/");
        const colors = extractColors(page.css, page.meta);
        expect(colors.theme).toBe("#0b1220");
        expect(colors.accents.slice(0, 2)).toEqual(["#ff6600", "#14b8a6"]);
        expect(colors.scheme).toBe("dark");
    });
    it("returns null when a page has no colors", () => {
        expect(extractColors("", {})).toBeNull();
    });
});

describe("the brief", () => {
    it("prefers the pit.world record and its JSON-LD", () => {
        const b = buildBrief({ url: "https://profullstack.com", record: RECORD, page: null, colors: null });
        expect(b).toMatchObject({ host: "profullstack.com", name: "Profullstack", slogan: "Agentic Engineering", logo: "https://profullstack.com/logo-black.png", record: true });
        expect(b.topics).toEqual(["Agentic engineering", "AI coding agents"]);
    });
    it("falls back to the page alone", () => {
        const page = readHtml(HTML, "https://acme.example/");
        const b = buildBrief({ url: "https://acme.example/", record: null, page, colors: extractColors(page.css, page.meta) });
        expect(b).toMatchObject({ name: "Acme Rockets", slogan: "Up we go", description: "Rockets for everyone & their dogs.", logo: "https://acme.example/favicon.png", record: false });
    });
});

describe("the image prompt", () => {
    const brief = { ...buildBrief({ url: "https://profullstack.com", record: RECORD }), colors: { theme: "#0b1220", accents: ["#14b8a6"], scheme: "dark" } };
    it("replaces the link with the brand and spells out the identity", () => {
        const p = brandImagePrompt("a banner ad for https://profullstack.com", [brief]);
        expect(p).not.toContain("https://");
        expect(p).toContain("a banner ad for Profullstack.");
        expect(p).toContain('tagline "Agentic Engineering"');
        expect(p).toContain("teal (#14b8a6)");
        expect(p).toContain('headline text reading "Profullstack"');
    });
    it("draws no lettering when the picture is not an ad", () => {
        expect(brandImagePrompt("a mascot for https://profullstack.com", [brief])).not.toContain("headline");
    });
    it("strips unreadable links and stays under the cap", () => {
        expect(brandImagePrompt("a cat at https://nope.example/x", [])).toBe("a cat at nope.example");
        const long = { ...brief, description: "x ".repeat(3000) };
        expect(brandImagePrompt("a banner for https://profullstack.com", [long]).length).toBeLessThanOrEqual(MAX_IMAGE_PROMPT_CHARS);
    });
    it("names colors", () => {
        expect(colorName("#14b8a6")).toBe("teal");
        expect(colorName("#ff6600")).toBe("orange");
        expect(colorName("#0b1220")).toBe("deep blue");
        expect(colorName("#111111")).toBe("black");
    });
    it("gives the text chat a profile block", () => {
        const ctx = brandContext(brief);
        expect(ctx).toContain("pit.world's site index");
        expect(ctx).toContain("Tagline: Agentic Engineering");
    });
});

describe("guards, index lookup and indexing", () => {
    it("refuses private addresses", () => {
        for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
            expect(isPrivateAddress(ip)).toBe(true);
        }
        for (const ip of ["1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
    });
    it("looks up the page record, then the site record", async () => {
        const seen = [];
        const fetchImpl = async (u) => {
            seen.push(String(u));
            return String(u).endsWith("/sites/example.com")
                ? new Response(JSON.stringify({ record: { title: "Example" } }), { status: 200 })
                : new Response("{}", { status: 404 });
        };
        expect(await lookupSiteRecord("https://www.example.com/pricing/", { fetchImpl })).toEqual({ title: "Example" });
        expect(seen).toEqual(["https://nichedb.dev/api/v1/sites/example.com/pricing", "https://nichedb.dev/api/v1/sites/example.com"]);
    });
    it("submits a URL to pit.world once a day", async () => {
        const calls = [];
        const fetchImpl = async (u, init) => { calls.push([String(u), JSON.parse(init.body)]); return new Response("{}", { status: 200 }); };
        expect(await submitToPitWorld("https://once.example/", { fetchImpl, now: 1 })).toBe(true);
        expect(await submitToPitWorld("https://once.example/", { fetchImpl, now: 2 })).toBe(false);
        expect(calls).toEqual([["https://pit.world/api/submit", { urls: ["https://once.example/"] }]]);
    });
});
