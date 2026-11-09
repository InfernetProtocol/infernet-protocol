import "server-only";

// Step 1 of a promo: read the site's branding. Reuses the chat's link reader
// (lib/site-brief.js): public-address guard pinned at connect time, redirect
// and size caps. Adds what a video needs on top of the brief: the page's key
// copy, the web app manifest's colors and icons, and the logo's bytes.

import { buildBrief, extractColors, fetchPublic, lookupSiteRecord, readHtml } from "../site-brief.js";

const PAGE_BYTES = 768 * 1024;
const CSS_BYTES = 512 * 1024;
const MANIFEST_BYTES = 64 * 1024;
const LOGO_BYTES = 2 * 1024 * 1024;
const TOTAL_MS = 20_000;

const decode = (s) => String(s ?? "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/\s+/g, " ")
  .trim();

/** Headings and lead paragraphs of the page body: what the site says about itself. */
export function extractCopy(html, { max = 14 } = {}) {
  const body = String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
  const out = [];
  const seen = new Set();
  for (const m of body.matchAll(/<(h1|h2|h3|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = decode(m[2]);
    const min = m[1].toLowerCase().startsWith("h") ? 6 : 30;
    if (text.length < min || text.length > 260) continue;
    if (/cookie|javascript|©|all rights reserved|sign in|log in|privacy policy/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;
const toHex6 = (c) => {
  const s = String(c ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s.slice(1).split("").map((x) => x + x).join("")}`;
  return HEX.test(s.slice(0, 7)) ? s.slice(0, 7) : null;
};
const lum = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

/**
 * The palette the video uses: `primary` (the brand's strongest accent),
 * `secondary`, `background` (end card) and `text` (readable on background).
 */
export function brandPalette({ colors = null, manifest = null } = {}) {
  const accents = (colors?.accents ?? []).map(toHex6).filter(Boolean);
  const theme = toHex6(colors?.theme) ?? toHex6(manifest?.theme_color);
  const bg = toHex6(manifest?.background_color) ?? theme;
  const dark = colors?.scheme === "dark" || (bg ? lum(bg) < 0.35 : false);
  const primary = accents[0] ?? (theme && lum(theme) > 0.12 && lum(theme) < 0.9 ? theme : null) ?? "#14b8a6";
  const secondary = accents[1] ?? accents[0] ?? "#f97316";
  const background = bg ?? (dark ? "#0a0a0b" : "#ffffff");
  return {
    primary,
    secondary,
    accent: accents[2] ?? secondary,
    background,
    text: lum(background) < 0.5 ? "#ffffff" : "#111111",
    scheme: lum(background) < 0.5 ? "dark" : "light"
  };
}

function iconCandidates(page, manifest, manifestUrl) {
  const out = [];
  const add = (href, size, kind) => { if (href) out.push({ href, size, kind }); };
  for (const icon of manifest?.icons ?? []) {
    try {
      const size = Math.max(...String(icon.sizes ?? "0").split(/\s+/).map((s) => Number(s.split("x")[0]) || 0));
      add(new URL(icon.src, manifestUrl).href, size, "manifest");
    } catch { /* bad icon */ }
  }
  for (const l of page?.links ?? []) {
    if (/apple-touch-icon/.test(l.rel)) add(l.href, 180, "apple");
    else if (/\bicon\b/.test(l.rel)) add(l.href, /\.svg(\?|$)/i.test(l.href) ? 512 : 32, "icon");
  }
  return out.sort((a, b) => b.size - a.size);
}

/** Image type from magic bytes: png, jpeg, webp, gif, svg, ico, or null. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buf.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return "ico";
  const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}

async function fetchImage(href) {
  const res = await fetchPublic(href, { binary: true, maxBytes: LOGO_BYTES, accept: "image/png,image/svg+xml,image/*;q=0.8", timeoutMs: 8_000 });
  if (res.status >= 400 || res.truncated) return null;
  const type = sniffImage(res.body);
  return type ? { bytes: res.body, type, url: res.url } : null;
}

async function readManifest(page, baseUrl) {
  const link = (page?.links ?? []).find((l) => /\bmanifest\b/.test(l.rel))?.href;
  const tries = link ? [link] : [new URL("/manifest.webmanifest", baseUrl).href, new URL("/manifest.json", baseUrl).href];
  for (const href of tries) {
    try {
      const res = await fetchPublic(href, { maxBytes: MANIFEST_BYTES, accept: "application/manifest+json,application/json", timeoutMs: 5_000 });
      if (res.status >= 400) continue;
      const json = JSON.parse(res.body);
      if (json && typeof json === "object") return { manifest: json, url: res.url };
    } catch { /* none */ }
  }
  return { manifest: null, url: null };
}

/**
 * Everything the promo needs from `url`. Throws (with `.status`) only when the
 * page cannot be read at all.
 * -> { url, host, name, tagline, description, copy[], topics[], colors, logo: {bytes,type,url}|null, image, favicon }
 */
export async function promoBrand(url, { lookup = lookupSiteRecord } = {}) {
  const deadline = new Promise((_, reject) => {
    setTimeout(() => reject(Object.assign(new Error("The site took too long to read."), { status: 504 })), TOTAL_MS).unref?.();
  });
  return Promise.race([read(), deadline]);

  async function read() {
    const [recordR, pageR] = await Promise.allSettled([lookup(url), fetchPublic(url, { maxBytes: PAGE_BYTES })]);
    const record = recordR.status === "fulfilled" ? recordR.value : null;
    const res = pageR.status === "fulfilled" ? pageR.value : null;
    if (!res || res.status >= 400) {
      if (!record) {
        const why = pageR.status === "rejected" ? pageR.reason?.message : `the page answered HTTP ${res?.status}`;
        throw Object.assign(new Error(`Could not read ${url}: ${why}`), { status: 422 });
      }
    }
    const html = res?.body ?? "";
    const finalUrl = res?.url ?? url;
    const page = html ? readHtml(html, finalUrl) : null;
    const origin = new URL(finalUrl).hostname.replace(/^www\./, "");
    const sheets = (page?.links ?? [])
      .filter((l) => /\bstylesheet\b/.test(l.rel) && !/print/.test(l.media))
      .filter((l) => { try { return new URL(l.href).hostname.replace(/^www\./, "").endsWith(origin); } catch { return false; } })
      .slice(0, 3);
    const [css, { manifest, url: manifestUrl }] = await Promise.all([
      Promise.all(sheets.map((s) => fetchPublic(s.href, { maxBytes: CSS_BYTES, accept: "text/css,*/*;q=0.1" }).then((r) => r.body, () => ""))),
      readManifest(page, finalUrl)
    ]);
    const colors = page ? extractColors(`${page.css}\n${css.join("\n")}`, page.meta) : null;
    const brief = buildBrief({ url, finalUrl, record, page, colors });

    // Logo: the declared logo, then the largest raster icon. SVG is kept (the
    // renderer rasterises it when it can) but a raster is preferred.
    const candidates = [
      ...(brief.logo ? [{ href: brief.logo, size: 1000, kind: "logo" }] : []),
      ...iconCandidates(page, manifest, manifestUrl ?? finalUrl)
    ];
    let logo = null;
    let svgLogo = null;
    for (const c of candidates.slice(0, 5)) {
      const img = await fetchImage(c.href).catch(() => null);
      if (!img || img.type === "gif" || img.type === "ico") continue;
      if (img.type === "svg") { svgLogo ??= img; continue; }
      logo = img;
      break;
    }
    logo ??= svgLogo;

    const meta = page?.meta ?? {};
    const tagline = brief.slogan || (meta["og:title"] && meta["og:title"] !== brief.name ? meta["og:title"].split(/\s+[|\-–—:]\s+/).slice(1).join(" ") : "") || null;
    return {
      url: finalUrl,
      host: brief.host,
      name: (manifest?.short_name && manifest.short_name.length <= 24 ? manifest.short_name : null) ?? brief.name,
      tagline: tagline ? String(tagline).slice(0, 120) : null,
      description: brief.description ? String(brief.description).slice(0, 600) : manifest?.description ?? null,
      copy: extractCopy(html),
      topics: brief.topics,
      colors: brandPalette({ colors, manifest }),
      logo,
      image: brief.image,
      favicon: candidates.find((c) => c.kind === "icon")?.href ?? null
    };
  }
}
