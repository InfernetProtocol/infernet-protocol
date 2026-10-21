import "server-only";

/**
 * Web search for the chat playground.
 *
 * Small CPU models can't drive tools, so the control plane does the browsing:
 * search (ValueSERP, the key /api/v1/search already uses), read the top pages
 * with TronBrowser's `tron automate` relay (Obscura first, full Chromium for
 * JS-heavy pages, returns markdown), and hand the model a short numbered
 * context it can cite as [1], [2]. The browser asks for it and prepends it to
 * the conversation, so it works for end-to-end encrypted chats too: only the
 * search query reaches the server, and only when the user turned search on.
 */

// ValueSERP runs a live Google query: ~10.5 s measured from dev2 (2026-10-21).
const SEARCH_TIMEOUT_MS = 25_000;
const PAGE_TIMEOUT_MS = 20_000;
const RESULTS = 5;
const PAGES = 3;
const PAGE_CHARS = 900;
const MIN_LINE_CHARS = 40;
const SNIPPET_CHARS = 300;
export const QUERY_MAX_LEN = 300;

export const TRON_MCP_URL = process.env.TRON_MCP_URL || "https://tronbrowser.dev/mcp/tron";

function clip(text, max) {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const stop = cut.lastIndexOf(". ");
    return (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut) + " …";
}

/**
 * Keep the words of a markdown page: drop images, link targets, and the short
 * lines that are navigation, menus and footers rather than content (a page's
 * first 1,200 characters were otherwise mostly "Skip to content · Docs ...").
 */
export function pageToText(markdown) {
    return String(markdown ?? "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^#+\s*/gm, "")
        .replace(/[*_`>|]+/g, " ")
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        // The relay appends a JSON status line: {"engine":"chromium","url":...}
        .filter((l) => l.length >= MIN_LINE_CHARS && !/^\{"engine":/.test(l))
        .join("\n");
}

// A bot check served instead of the page ("verifies you are not a bot",
// Cloudflare's "Just a moment"). Its text would only mislead the model.
const INTERSTITIAL = /(not a (ro)?bot|verify(ing)? you are human|just a moment|enable javascript and cookies|attention required)/i;

/** Page text worth showing the model, or "" for an interstitial. */
export function usablePageText(markdown) {
    const text = pageToText(markdown);
    return INTERSTITIAL.test(text.slice(0, 600)) ? "" : text;
}

/** @returns {Promise<Array<{ title: string, url: string, snippet: string }>>} */
export async function searchWeb(query, { apiKey = process.env.VALUESERP_API_KEY, fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error("web search is not configured (VALUESERP_API_KEY)");
    // English results and dates; unset, dev2 got Google Japan ("2026年8月3日").
    const params = new URLSearchParams({ api_key: apiKey, q: query, num: String(RESULTS + 1), hl: "en", gl: "us", google_domain: "google.com" });
    const res = await fetchImpl(`https://api.valueserp.com/search?${params}`, {
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        cache: "no-store"
    });
    if (!res.ok) throw new Error(`search provider returned ${res.status}`);
    const body = await res.json();
    return (body?.organic_results ?? [])
        .filter((r) => typeof r?.link === "string" && /^https?:\/\//.test(r.link))
        .slice(0, RESULTS)
        .map((r) => ({ title: String(r.title ?? r.link), url: r.link, snippet: String(r.snippet ?? "") }));
}

/** Page text through the TronBrowser automate relay (MCP tools/call fetch_page). */
export async function fetchPageText(url, { fetchImpl = fetch, mcpUrl = TRON_MCP_URL } = {}) {
    const res = await fetchImpl(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch_page", arguments: { url } } }),
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        cache: "no-store"
    });
    if (!res.ok) throw new Error(`tron relay returned ${res.status}`);
    const body = await res.json();
    if (body?.error || body?.result?.isError) throw new Error(body?.error?.message ?? "fetch_page failed");
    return (body?.result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
}

/**
 * Search, read the top pages, and build the context block.
 * @returns {Promise<{ query: string, sources: Array<{ n, title, url, snippet, read }>, context: string }>}
 */
export async function buildWebContext(query, { now = new Date(), fetchImpl = fetch, apiKey } = {}) {
    const results = await searchWeb(query, { apiKey, fetchImpl });
    const pages = await Promise.allSettled(
        results.slice(0, PAGES).map((r) => fetchPageText(r.url, { fetchImpl }))
    );
    const sources = results.map((r, i) => {
        const page = pages[i]?.status === "fulfilled" ? clip(usablePageText(pages[i].value), PAGE_CHARS) : "";
        return { n: i + 1, title: clip(r.title, 120), url: r.url, snippet: clip(r.snippet, SNIPPET_CHARS), text: page, read: Boolean(page) };
    });
    const day = now.toISOString().slice(0, 10);
    const blocks = sources.map((s) =>
        // The search snippet carries the date and usually the answer; the page adds detail.
        [`[${s.n}] ${s.title}`, s.url, s.snippet, s.text].filter(Boolean).join("\n")
    );
    const context = sources.length === 0
        ? `Web search for "${query}" (${day}) found nothing. Say that you could not find web results, then answer from what you know.`
        : [
            `Web search results for "${query}", retrieved ${day}.`,
            "Answer the user's question using these results. Cite them inline as [1], [2]. If they do not answer it, say so and do not make up facts.",
            "",
            blocks.join("\n\n")
        ].join("\n");
    return { query, sources: sources.map(({ text, ...s }) => s), context };
}
