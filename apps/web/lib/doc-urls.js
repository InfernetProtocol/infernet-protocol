/**
 * Links in a chat message that the chat should read before answering
 * ("summarize this https://arxiv.org/pdf/2106.01820"). Shared by the browser
 * (to decide whether to read) and the server (to validate what it was sent).
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
export const MAX_DOC_URLS = 2;

/** Up to MAX_DOC_URLS distinct http(s) links, trailing punctuation removed. */
export function findDocumentUrls(text) {
    const found = [];
    for (const match of String(text ?? "").matchAll(URL_RE)) {
        let url = match[0].replace(/[).,;:!?\]}>]+$/, "");
        // Keep a closing paren that belongs to the URL, as in Wikipedia links.
        if (/\([^)]*$/.test(url) && match[0].slice(url.length).startsWith(")")) url += ")";
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
            if (!found.includes(parsed.href)) found.push(parsed.href);
        } catch { /* not a URL */ }
        if (found.length >= MAX_DOC_URLS) break;
    }
    return found;
}
