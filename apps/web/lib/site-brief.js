import "server-only";

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

/**
 * What the chat knows about a site someone linked: name, tagline, what it does,
 * logo, share image and brand colors. Used by the text chat (as context next to
 * the readm3 text) and by image mode (lib/brand-prompt.js writes the prompt).
 *
 * Three sources, all in parallel, each optional:
 *   1. pit.world's index: the OpenSite record its crawler (pitbot) publishes to
 *      nichedb /api/v1/sites/<host>/<path>. Clean name, description, JSON-LD
 *      (logo, slogan, knowsAbout), share cards, feeds.
 *   2. The page itself: meta tags, JSON-LD, theme-color and the colors its CSS
 *      uses, fetched here behind a public-address guard.
 *   3. Indexing: every linked URL is submitted to pit.world/api/submit, so the
 *      crawler reads the whole site and the next person who links it gets a record.
 */

const PAGE_TIMEOUT_MS = 8_000;
const RECORD_TIMEOUT_MS = 4_000;
const MAX_HTML_BYTES = 768 * 1024;
const MAX_CSS_BYTES = 512 * 1024;
const MAX_STYLESHEETS = 3;
const UA = "InfernetChat/1.0 (+https://infernetprotocol.com/chat; reads links a user pasted)";

const env = (name) => process.env[name];
const nichedbBase = () => (env("NICHEDB_URL") || "https://nichedb.dev").replace(/\/+$/, "");
const pitWorldBase = () => (env("PIT_WORLD_URL") || "https://pit.world").replace(/\/+$/, "");

// ── public-address guard ─────────────────────────────────────────────────────

function privateV4(ip) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19));
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) return privateV4(ip);
    if (!net.isIPv6(ip)) return true;
    const v6 = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return privateV4(mapped[1]);
    return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6) || v6.startsWith("64:ff9b:") || v6.startsWith("2001:db8");
}

/** dns.lookup that refuses non-public answers, so the connection itself is pinned to a public IP. */
function publicLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const bad = addresses.find((a) => isPrivateAddress(a.address));
        if (bad || !addresses.length) return callback(Object.assign(new Error("Only public addresses are read."), { code: "EPRIVATE" }));
        if (options?.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
    });
}

/**
 * GET a public http(s) URL: follows up to 3 redirects, stops at `maxBytes`.
 * Resolves { url, status, type, body } or rejects.
 */
export function fetchPublic(url, { maxBytes = MAX_HTML_BYTES, timeoutMs = PAGE_TIMEOUT_MS, accept = "text/html,*/*;q=0.5", redirects = 3 } = {}) {
    return new Promise((resolve, reject) => {
        let target;
        try { target = new URL(url); } catch { return reject(new Error("Not a URL")); }
        if (target.protocol !== "http:" && target.protocol !== "https:") return reject(new Error("Only http(s) links are read."));
        if (net.isIP(target.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(target.hostname.replace(/^\[|\]$/g, ""))) {
            return reject(new Error("Only public addresses are read."));
        }
        const lib = target.protocol === "https:" ? https : http;
        const req = lib.get(target, { headers: { "user-agent": UA, accept }, lookup: publicLookup, timeout: timeoutMs }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirects <= 0) return reject(new Error("Too many redirects"));
                let next;
                try { next = new URL(res.headers.location, target).href; } catch { return reject(new Error("Bad redirect")); }
                return resolve(fetchPublic(next, { maxBytes, timeoutMs, accept, redirects: redirects - 1 }));
            }
            const chunks = [];
            let size = 0;
            res.on("data", (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
                    res.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            const done = () => resolve({ url: target.href, status, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") });
            res.on("end", done);
            res.on("close", done);
            res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error("The page did not answer in time.")));
        req.on("error", reject);
    });
}

// ── reading a page ───────────────────────────────────────────────────────────

const decode = (s) => String(s ?? "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).trim();

function attrs(tag) {
    const out = {};
    for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
        out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
    }
    return out;
}

/** Meta tags, links, title and JSON-LD of an HTML document. */
export function readHtml(html, baseUrl) {
    const head = String(html ?? "");
    const meta = {};
    for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
        const a = attrs(m[0]);
        const key = (a.property || a.name || a.itemprop || "").toLowerCase();
        if (key && a.content && !(key in meta)) meta[key] = a.content;
    }
    const links = [];
    for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
        const a = attrs(m[0]);
        if (!a.href) continue;
        try { links.push({ rel: (a.rel ?? "").toLowerCase(), href: new URL(a.href, baseUrl).href, media: a.media ?? "" }); } catch { /* bad href */ }
    }
    const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "");
    const jsonld = [];
    for (const m of head.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            const data = JSON.parse(m[1].trim());
            const items = Array.isArray(data) ? data : data?.["@graph"] ?? [data];
            for (const item of items) if (item && typeof item === "object") jsonld.push(item);
        } catch { /* broken JSON-LD */ }
    }
    const styles = [...head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
    const inlineStyles = [...head.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]).join(";");
    return { meta, links, title, jsonld, css: `${styles}\n${inlineStyles}` };
}

// ── colors ───────────────────────────────────────────────────────────────────

function toHex(raw) {
    const s = String(raw ?? "").trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return `#${m[1].split("").map((c) => c + c).join("")}`;
    m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
    if (m) return `#${m[1]}`;
    m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(s);
    if (m) return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
    return null;
}

function hsl(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = (n >> 16) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    return { s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}

const BRAND_VAR = /--[\w-]*(brand|primary|accent|theme|highlight|main|cta|link)[\w-]*\s*:\s*([^;}{]+)/gi;
const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi;

/**
 * The site's colors from its theme-color and CSS: `theme` (declared), up to four
 * saturated `accents` (custom properties named brand/primary/accent count 6x a
 * plain use), and `scheme` dark|light from which neutral dominates.
 */
export function extractColors(css, meta = {}) {
    const score = new Map();
    const add = (raw, weight) => {
        const hex = toHex(raw);
        if (hex) score.set(hex, (score.get(hex) ?? 0) + weight);
    };
    for (const m of String(css ?? "").matchAll(BRAND_VAR)) {
        for (const t of m[2].matchAll(COLOR_TOKEN)) add(t[0], 6);
    }
    for (const t of String(css ?? "").matchAll(COLOR_TOKEN)) add(t[0], 1);
    const theme = toHex(meta["theme-color"]) ?? toHex(meta["msapplication-tilecolor"]);

    let dark = 0;
    let light = 0;
    const accents = [];
    for (const [hex, weight] of [...score.entries()].sort((a, b) => b[1] - a[1])) {
        const { s, l } = hsl(hex);
        if (s < 0.18 || l < 0.08 || l > 0.95) {
            if (l < 0.25) dark += weight;
            else if (l > 0.85) light += weight;
            continue;
        }
        // Skip near-duplicates of a color already kept.
        if (accents.some((a) => Math.abs(Number.parseInt(a.slice(1), 16) - Number.parseInt(hex.slice(1), 16)) < 0x0a0a0a)) continue;
        accents.push(hex);
        if (accents.length >= 4) break;
    }
    // A declared theme-color is the page's own answer; text colors (white on a
    // dark site) would otherwise outvote the background.
    const themeL = theme ? hsl(theme).l : null;
    const scheme = themeL !== null && themeL < 0.2 ? "dark"
        : themeL !== null && themeL > 0.9 ? "light"
        : dark === 0 && light === 0 ? null : dark >= light ? "dark" : "light";
    if (!theme && !accents.length && !scheme) return null;
    return { theme: theme ?? null, accents: accents.filter((a) => a !== theme), scheme };
}

// ── pit.world / nichedb site record ──────────────────────────────────────────

/** The OpenSite record pit.world's crawler published for this URL (or its site), or null. */
export async function lookupSiteRecord(url, { fetchImpl = fetch } = {}) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (net.isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".")) return null;
    const path = u.pathname.replace(/\/+$/, "");
    const tries = path ? [`${host}${path}`, host] : [host];
    for (const key of tries) {
        try {
            const res = await fetchImpl(`${nichedbBase()}/api/v1/sites/${key.split("/").map(encodeURIComponent).join("/")}`, {
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(RECORD_TIMEOUT_MS),
                cache: "no-store"
            });
            if (!res.ok) continue;
            const body = await res.json().catch(() => null);
            if (body?.record) return body.record;
        } catch { /* index slow or down: the page still answers */ }
    }
    return null;
}

// ── indexing ─────────────────────────────────────────────────────────────────

const submitted = new Map();
const RESUBMIT_MS = 24 * 60 * 60 * 1000;

/** Queue the URL in pit.world's crawler (at most once a day per URL per process). Never throws. */
export async function submitToPitWorld(url, { fetchImpl = fetch, now = Date.now() } = {}) {
    if (env("CHAT_PIT_SUBMIT") === "0") return false;
    const last = submitted.get(url);
    if (last && now - last < RESUBMIT_MS) return false;
    submitted.set(url, now);
    if (submitted.size > 5_000) submitted.delete(submitted.keys().next().value);
    try {
        const res = await fetchImpl(`${pitWorldBase()}/api/submit`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ urls: [url] }),
            signal: AbortSignal.timeout(6_000)
        });
        return res.ok;
    } catch {
        return false;
    }
}

// ── the brief ────────────────────────────────────────────────────────────────

const ORG_TYPES = /^(Organization|Corporation|LocalBusiness|Brand|WebSite|SoftwareApplication|Product|NGO|OnlineBusiness|ProfessionalService|Store)$/i;

function typesOf(item) {
    const t = item?.["@type"];
    return Array.isArray(t) ? t : t ? [t] : [];
}

function urlOf(v) {
    if (!v) return null;
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return urlOf(v[0]);
    return v.url ?? v.contentUrl ?? v["@id"] ?? null;
}

function pickOrg(jsonld) {
    const list = (jsonld ?? []).filter((i) => typesOf(i).some((t) => ORG_TYPES.test(t)));
    return list.find((i) => typesOf(i).some((t) => /Organization|Corporation|Business|Brand/i.test(t))) ?? list[0] ?? null;
}

function cleanTitle(title, siteName) {
    const t = String(title ?? "").trim();
    if (!t) return null;
    if (siteName) return siteName;
    return t.split(/\s+[|\-–—·:]\s+/)[0].trim() || t;
}

function topicsOf(org, record) {
    const raw = org?.knowsAbout ?? org?.keywords ?? null;
    let list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
    list = list.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean).map((t) => t.trim());
    if (!list.length && Array.isArray(record?.tags)) list = record.tags;
    return [...new Set(list)].slice(0, 8);
}

/** Merge the index record and the page into one brief. Pure, for tests. */
export function buildBrief({ url, finalUrl, record, page, colors }) {
    const host = (() => { try { return new URL(finalUrl ?? url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    const meta = page?.meta ?? {};
    const og = record?.cards?.og ?? {};
    const jsonld = [...(record?.jsonld ?? []), ...(page?.jsonld ?? [])];
    const org = pickOrg(jsonld);
    const siteName = record?.site?.name || meta["og:site_name"] || org?.alternateName || org?.name || null;
    const name = cleanTitle(record?.title ?? page?.title ?? og["og:title"], siteName) || host;
    const icon = (page?.links ?? []).find((l) => /apple-touch-icon/.test(l.rel))?.href ??
        (page?.links ?? []).find((l) => /\bicon\b/.test(l.rel))?.href ?? null;
    return {
        url,
        finalUrl: finalUrl ?? url,
        host,
        name,
        slogan: org?.slogan || null,
        description: record?.description || meta["og:description"] || meta.description || org?.description || null,
        topics: topicsOf(org, record),
        logo: urlOf(org?.logo) || icon,
        image: record?.image?.url || urlOf(og["og:image"]) || meta["og:image"] || meta["twitter:image"] || null,
        feeds: Array.isArray(record?.feeds) ? record.feeds.slice(0, 5) : [],
        colors: colors ?? null,
        record: Boolean(record),
        title: record?.title ?? page?.title ?? name
    };
}

async function readPage(url) {
    const res = await fetchPublic(url);
    if (res.status >= 400) throw new Error(`The page answered ${res.status}`);
    if (!/html|xml/i.test(res.type) && !/^\s*</.test(res.body)) return { finalUrl: res.url, page: null, colors: null };
    const page = readHtml(res.body, res.url);
    // The site's own stylesheets carry its colors; a CDN framework sheet mostly does not.
    const origin = new URL(res.url).hostname.replace(/^www\./, "");
    const sheets = page.links
        .filter((l) => /\bstylesheet\b/.test(l.rel) && !/print/.test(l.media))
        .filter((l) => { try { return new URL(l.href).hostname.replace(/^www\./, "").endsWith(origin); } catch { return false; } })
        .slice(0, MAX_STYLESHEETS);
    const css = await Promise.all(sheets.map((s) => fetchPublic(s.href, { maxBytes: MAX_CSS_BYTES, accept: "text/css,*/*;q=0.1" }).then((r) => r.body, () => "")));
    return { finalUrl: res.url, page, colors: extractColors(`${page.css}\n${css.join("\n")}`, page.meta) };
}

/**
 * Everything the chat can learn about `url` in a few seconds, and the URL queued
 * for indexing. Never throws: a field it could not learn is null. Returns null
 * only when nothing at all was learned.
 */
export async function siteBrief(url, { submit = true } = {}) {
    if (submit) submitToPitWorld(url).catch(() => {});
    const [recordR, pageR] = await Promise.allSettled([lookupSiteRecord(url), readPage(url)]);
    const record = recordR.status === "fulfilled" ? recordR.value : null;
    const page = pageR.status === "fulfilled" ? pageR.value : null;
    if (!record && !page?.page) return null;
    return buildBrief({ url, finalUrl: page?.finalUrl, record, page: page?.page, colors: page?.colors });
}
