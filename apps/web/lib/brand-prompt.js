/**
 * Turn what the chat learned about a linked site (lib/site-brief.js) into words
 * a model can use. Pure and browser-safe: the chat page builds the image prompt
 * itself, and the server builds the text-chat context, from the same brief.
 *
 * A text-to-image model has never seen the site and cannot open a link, so
 * "a banner ad for https://example.com" draws a generic banner. Spelling out the
 * name, tagline, what the business does and its colors is what makes it on-brand.
 */

import { MAX_IMAGE_PROMPT_CHARS } from "./billing/image.js";

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/**
 * Requests that are about the brand itself (an ad for it, its logo, in its
 * style). Anything else that links a page wants the page's content, not its
 * branding: "draw what this article describes https://...".
 */
const WANTS_BRANDING = /\b(brand|branding|branded|on-brand|banner|ads?|advert|advertisement|logo|logotype|poster|flyer|billboard|marketing|promo|promotional|campaign|hero|header|cover|thumbnail|og image|social (?:post|card|image)|business card|mascot|merch|look and feel|style of|in (?:its|their|the site'?s) style|colou?rs? (?:of|from)|identity)\b/i;

/** True when the request is about the linked site's brand rather than what the page says. */
export function wantsBranding(prompt) {
    return WANTS_BRANDING.test(String(prompt ?? ""));
}

/** Images where lettering is the point: the name (and tagline) should be drawn. */
const WANTS_TEXT = /\b(banner|ad|ads|advert|advertisement|poster|flyer|billboard|header|hero|cover|thumbnail|logo|card|sign|signage|social post|og image)\b/i;

function clip(text, max) {
    const s = String(text ?? "").replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
    return (stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.replace(/\s+\S*$/, "")}…`).trim();
}

/** "#14b8a6" -> "teal". Rough names, because image models follow names better than hex. */
export function colorName(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ""));
    if (!m) return null;
    const n = Number.parseInt(m[1], 16);
    const r = (n >> 16) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (s < 0.15) {
        if (l < 0.12) return "black";
        if (l < 0.35) return "charcoal";
        if (l < 0.7) return "gray";
        if (l < 0.93) return "light gray";
        return "white";
    }
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    const hues = [
        [15, "red"], [40, "orange"], [55, "amber"], [70, "yellow"], [90, "lime"], [150, "green"],
        [185, "teal"], [200, "cyan"], [225, "blue"], [255, "indigo"], [285, "violet"], [320, "magenta"], [345, "pink"], [360, "red"]
    ];
    let name = hues.find(([edge]) => h < edge)?.[1] ?? "red";
    if (name === "orange" && l < 0.35) name = "brown";
    const shade = l < 0.25 ? "deep " : l > 0.78 ? "pale " : "";
    return `${shade}${name}`;
}

function describeColors(colors) {
    if (!colors) return "";
    const list = [colors.theme, ...(colors.accents ?? [])].filter(Boolean);
    const seen = new Set();
    const named = [];
    for (const hex of list) {
        const name = colorName(hex);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        named.push(`${name} (${hex})`);
        if (named.length >= 4) break;
    }
    const scheme = colors.scheme ? `${colors.scheme} background` : "";
    return [named.length ? `brand colors ${named.join(", ")}` : "", scheme].filter(Boolean).join(", on a ");
}

/**
 * The image prompt for `userPrompt` given the briefs of the sites it linked.
 * Links in the prompt are replaced by the site's name; the brand details follow.
 */
export function brandImagePrompt(userPrompt, briefs = [], { max = MAX_IMAGE_PROMPT_CHARS } = {}) {
    const usable = (briefs ?? []).filter((b) => b && (b.name || b.description || b.colors));
    let prompt = String(userPrompt ?? "");
    for (const b of usable) {
        const label = b.name || b.host;
        prompt = prompt.split(b.url).join(label);
        if (b.finalUrl) prompt = prompt.split(b.finalUrl).join(label);
    }
    // Any link left (one that could not be read) means nothing to the model.
    prompt = prompt.replace(URL_RE, (u) => {
        try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
    }).replace(/\s+/g, " ").trim();
    if (!usable.length) return prompt.slice(0, max);

    const wantsText = WANTS_TEXT.test(prompt);
    const parts = [prompt.replace(/[.\s]+$/, "") + "."];
    for (const b of usable) {
        const name = b.name || b.host;
        const lines = [];
        const about = clip(b.description, 260);
        lines.push(`The brand is ${name}${b.slogan ? `, tagline "${clip(b.slogan, 80)}"` : ""}${about ? `: ${about}` : "."}`);
        if (b.topics?.length) lines.push(`It is about ${b.topics.slice(0, 5).join(", ")}.`);
        const colors = describeColors(b.colors);
        if (colors) lines.push(`Use the brand's visual identity: ${colors}.`);
        if (wantsText) {
            lines.push(`Large clean headline text reading "${name}"${b.slogan ? ` with the smaller line "${clip(b.slogan, 60)}"` : ""}, spelled exactly, legible sans-serif type.`);
        }
        parts.push(lines.join(" "));
    }
    parts.push("Modern, polished, professional design with strong composition and generous negative space.");
    let out = parts.join(" ");
    if (out.length > max) out = `${out.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
    return out;
}

/**
 * The image prompt for a request that wants what a linked page is about (not
 * its branding): each link becomes a short description of the page.
 */
export function contentImagePrompt(userPrompt, briefs = [], { max = MAX_IMAGE_PROMPT_CHARS } = {}) {
    let prompt = String(userPrompt ?? "");
    for (const b of (briefs ?? []).filter(Boolean)) {
        const about = [b.title && b.title !== b.name ? b.title : b.name, clip(b.description, 300)].filter(Boolean).join(": ");
        const label = about ? `(${about})` : b.host;
        prompt = prompt.split(b.url).join(label);
        if (b.finalUrl) prompt = prompt.split(b.finalUrl).join(label);
    }
    prompt = prompt.replace(URL_RE, (u) => {
        try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
    }).replace(/\s+/g, " ").trim();
    return prompt.length > max ? `${prompt.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : prompt;
}

/** The rule-based image prompt (used when no model is available to write one). */
export function ruleImagePrompt(userPrompt, briefs = []) {
    return wantsBranding(userPrompt) ? brandImagePrompt(userPrompt, briefs) : contentImagePrompt(userPrompt, briefs);
}

/** The system-message section a text chat gets for one linked site. */
export function brandContext(brief) {
    if (!brief) return "";
    const rows = [
        brief.name ? `Name: ${brief.name}` : null,
        brief.slogan ? `Tagline: ${brief.slogan}` : null,
        brief.description ? `About: ${clip(brief.description, 500)}` : null,
        brief.topics?.length ? `Topics: ${brief.topics.slice(0, 8).join(", ")}` : null,
        describeColors(brief.colors) ? `Visual identity: ${describeColors(brief.colors)}` : null,
        brief.logo ? `Logo: ${brief.logo}` : null,
        brief.image ? `Share image: ${brief.image}` : null,
        brief.feeds?.length ? `Feeds: ${brief.feeds.slice(0, 3).join(", ")}` : null
    ].filter(Boolean);
    if (!rows.length) return "";
    const source = brief.record ? "pit.world's site index and the page itself" : "the page itself";
    return [
        `Background on ${brief.host}, from ${source}. The user's request decides what to do with the link: use these details only where the request needs them, and do not analyze or comment on branding unless the user asked about it.`,
        ...rows.map((r) => `- ${r}`)
    ].join("\n");
}
