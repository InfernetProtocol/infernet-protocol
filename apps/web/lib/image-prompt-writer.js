import "server-only";

import { streamChatCompletion, isNimConfigured } from "@infernetprotocol/nim-adapter";
import { MAX_IMAGE_PROMPT_CHARS } from "./billing/image.js";
import { brandContext, ruleImagePrompt } from "./brand-prompt.js";
import { fitText } from "./read-url.js";

/**
 * Write the text-to-image prompt for an image request that links pages.
 *
 * The image model cannot open a link and does exactly what its prompt says, so
 * something has to decide what the user wants done WITH the link: an ad in the
 * site's branding, a picture of what an article describes, a scene "in the style
 * of" a site. A chat model reads the request, the site profile and the page text
 * and writes one prompt. When no model is configured or it fails, the rule in
 * lib/brand-prompt.js (branding words -> brand prompt, else page content) does it.
 */

const WRITER_TIMEOUT_MS = 20_000;
const PAGE_CHARS = 2_500;
const MAX_OUT = 1_200;

export const WRITER_SYSTEM = [
    "You write one prompt for a text-to-image model (Z-Image-Turbo). The model cannot open links and draws only what your prompt describes.",
    "The user gave an image request that links one or more web pages. Below it you get, per link, a site profile and the start of the page text.",
    "Do exactly what the user asked with the link, nothing more:",
    "- If they want something for or about the brand (an ad, banner, logo, poster, a picture in the site's style or colors), use the profile: name, tagline, what it does, colors by name. The headline is the brand name and any tagline is the profile's tagline word for word; never invent slogans or copy.",
    "- If they want the page's content pictured (what an article, product or recipe describes), depict that content; do not add the site's branding, logo or colors.",
    "- Otherwise follow their wording; use only the details their request implies.",
    "Only include lettering the user asked for or an ad/banner/poster needs, and spell it out in quotes, e.g. headline text \"Acme\".",
    "Write 2 to 4 vivid, concrete sentences: the subject and the details the page gives about it, setting, composition, style (photo, illustration, flat vector ...), lighting and palette.",
    `Reply with the prompt only: no preamble, no quotes around it, no URLs, at most ${MAX_OUT} characters.`
].join("\n");

/** The user message for the writer: the request plus what each link said. */
export function writerInput(request, sources) {
    const parts = [`IMAGE REQUEST:\n${request}`];
    for (const s of sources) {
        const lines = [`LINK: ${s.url}`];
        const profile = brandContext(s.brief);
        if (profile) lines.push(`SITE PROFILE:\n${profile}`);
        if (s.text) lines.push(`PAGE TEXT (start):\n${fitText(s.text, PAGE_CHARS).text}`);
        if (lines.length === 1) lines.push("(the link could not be read)");
        parts.push(lines.join("\n"));
    }
    return parts.join("\n\n");
}

/** A model reply cleaned into a usable prompt, or null if it is not one. */
export function cleanWriterReply(text) {
    let s = String(text ?? "").trim();
    s = s.replace(/^(?:here(?:'s| is)[^:\n]*:|prompt:|image prompt:)\s*/i, "").trim();
    s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
    s = s.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
    if (s.length < 12) return null;
    return s.length > MAX_IMAGE_PROMPT_CHARS ? `${s.slice(0, MAX_IMAGE_PROMPT_CHARS - 1).replace(/\s+\S*$/, "")}…` : s;
}

/**
 * { prompt, writer: "model" | "rules" } for `request` given `sources`
 * ([{ url, brief, text }]). Never throws.
 */
export async function writeImagePrompt(request, sources, { stream = streamChatCompletion, configured = isNimConfigured() } = {}) {
    const rules = () => ({ prompt: ruleImagePrompt(request, sources.map((s) => s.brief).filter(Boolean)), writer: "rules" });
    if (!configured) return rules();
    try {
        let text = "";
        const signal = AbortSignal.timeout(WRITER_TIMEOUT_MS);
        for await (const ev of stream({
            messages: [
                { role: "system", content: WRITER_SYSTEM },
                { role: "user", content: writerInput(request, sources) }
            ],
            maxTokens: 400,
            temperature: 0.4,
            signal
        })) {
            if (ev.type === "token") text += ev.data?.text ?? "";
            else if (ev.type === "done") text = ev.data?.text ?? text;
            else if (ev.type === "error") throw new Error(ev.data?.message ?? "writer failed");
        }
        const prompt = cleanWriterReply(text);
        return prompt ? { prompt, writer: "model" } : rules();
    } catch (e) {
        console.warn("[image-prompt-writer]", e?.message ?? e);
        return rules();
    }
}
