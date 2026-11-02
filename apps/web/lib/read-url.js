import "server-only";

/**
 * Read a linked document for the chat playground through readm3's reader
 * (https://readm3.com/api/v1/read: PDFs, web pages, office files, text; public
 * addresses only, no login, a free hourly allowance and then x402).
 *
 * The small models on the network have a few thousand tokens of context, so the
 * document is cut to a budget the model can hold next to its answer: most of it
 * from the start (title, abstract, introduction) and the rest from the end
 * (conclusion), with a marker where the middle was left out. The browser prepends
 * the result as a system message, as it does for web search, so this works for
 * end-to-end encrypted chats: only the URL reaches the server.
 */

const READ_TIMEOUT_MS = 45_000;
export const DOC_CHARS = Math.max(2_000, Number.parseInt(process.env.CHAT_DOC_CHARS ?? "7000", 10) || 7_000);

function apiBase() {
    return (process.env.READM3_API_URL ?? "https://readm3.com/api/v1").replace(/\/$/, "");
}

export class ReadError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

/** The document's text through readm3, or a ReadError saying why not. */
export async function readDocument(url, { fetchImpl = fetch } = {}) {
    const token = process.env.READM3_TOKEN?.trim();
    let res;
    try {
        res = await fetchImpl(`${apiBase()}/read`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                // A readm3 account is not metered; without one the free allowance applies.
                ...(token ? { authorization: `Bearer ${token}` } : {})
            },
            body: JSON.stringify({ url, maxChars: 200_000 }),
            signal: AbortSignal.timeout(READ_TIMEOUT_MS),
            cache: "no-store"
        });
    } catch {
        throw new ReadError("The document reader did not answer in time.");
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 402) throw new ReadError("The free document-reading allowance is used up for now. Try again in an hour.", 429);
    if (!res.ok) throw new ReadError(body?.error ?? `The document reader answered ${res.status}.`, res.status >= 500 ? 502 : 422);
    if (typeof body?.text !== "string") throw new ReadError("The document reader returned no text.");
    return body;
}

/** Fit `text` into `budget` characters: the start and the end, cut on line breaks. */
export function fitText(text, budget = DOC_CHARS) {
    const clean = String(text ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length <= budget) return { text: clean, omitted: 0 };
    const headBudget = Math.floor(budget * 0.75);
    const tailBudget = budget - headBudget;
    let head = clean.slice(0, headBudget);
    const headCut = head.lastIndexOf("\n");
    if (headCut > headBudget * 0.8) head = head.slice(0, headCut);
    let tail = clean.slice(clean.length - tailBudget);
    const tailCut = tail.indexOf("\n");
    if (tailCut >= 0 && tailCut < tailBudget * 0.2) tail = tail.slice(tailCut + 1);
    const omitted = clean.length - head.length - tail.length;
    return { text: `${head}\n\n[… ${omitted.toLocaleString("en-US")} characters from the middle of the document left out …]\n\n${tail}`, omitted };
}

const BACK_MATTER = /^\s*(?:\d+\.?\s+)?(references|bibliography|works cited|literature cited|notes and references)\s*:?\s*$/i;

/**
 * The text without a paper's trailing reference list: with only room for the
 * start and the end, the end should be the conclusion, not forty citations.
 * Only a heading in the last half counts, so a "References" early on stays.
 */
export function dropBackMatter(text) {
    const lines = String(text ?? "").split("\n");
    for (let i = lines.length - 1; i >= Math.floor(lines.length / 2); i--) {
        if (BACK_MATTER.test(lines[i])) return lines.slice(0, i).join("\n").trimEnd();
    }
    return String(text ?? "");
}

/** The system message for one read document. */
export function documentContext(doc, { budget = DOC_CHARS } = {}) {
    const { text, omitted } = fitText(dropBackMatter(doc.text), budget);
    const about = [doc.kind === "pdf" ? "PDF" : doc.kind, doc.pages ? `${doc.pages} pages` : null, `${Number(doc.chars ?? text.length).toLocaleString("en-US")} characters`]
        .filter(Boolean).join(", ");
    return [
        `The user linked a document. Its text, fetched just now from ${doc.finalUrl ?? doc.url} (${about}), is below between the markers.`,
        "Answer the user's request from this document: if they ask for a summary, summarize what the document says, in the form and level they asked for. Do not invent details it does not contain.",
        omitted > 0 ? "Only the beginning and the end of the document are included because of its length; say so if the answer may depend on the middle." : "",
        "",
        `--- BEGIN DOCUMENT: ${doc.title ?? doc.url} ---`,
        text,
        "--- END DOCUMENT ---"
    ].filter((line, i) => line !== "" || i === 3).join("\n");
}
