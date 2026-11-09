import { NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { findDocumentUrls } from "@/lib/doc-urls";
import { readDocument, documentContext, ReadError } from "@/lib/read-url";
import { siteBrief } from "@/lib/site-brief";
import { brandContext } from "@/lib/brand-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/chat/read  { url }  ->  { url, title, kind, pages, chars, truncated, context }
 *
 * Reads a document the user linked (lib/read-url.js, through readm3's reader)
 * and returns a system message the browser prepends to this turn, the same way
 * web search does, so an end-to-end encrypted chat sends only the URL here.
 */

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
const DAILY_CAP = Number.parseInt(process.env.CHAT_READ_DAILY_CAP ?? "1000", 10);
const daily = { day: "", count: 0 };

const err = (status, error) => NextResponse.json({ error }, { status });

export async function POST(request) {
    const r = limit.check(getClientIp(request));
    if (!r.ok) return err(429, "Document reading limit reached for now. Try again later.");

    let payload;
    try { payload = await request.json(); } catch { return err(400, "Invalid JSON body"); }
    const [url] = findDocumentUrls(typeof payload?.url === "string" ? payload.url.slice(0, 2048) : "");
    if (!url) return err(400, "url must be an http(s) link");

    const today = new Date().toISOString().slice(0, 10);
    if (daily.day !== today) { daily.day = today; daily.count = 0; }
    if (daily.count >= DAILY_CAP) return err(429, "Document reading is at its daily limit. It resets at 00:00 UTC.");
    daily.count += 1;

    const [docR, briefR] = await Promise.allSettled([readDocument(url), siteBrief(url)]);
    const brief = briefR.status === "fulfilled" ? briefR.value : null;
    const profile = brandContext(brief);

    if (docR.status === "fulfilled") {
        const doc = docR.value;
        const context = profile ? `${documentContext(doc)}\n\n${profile}` : documentContext(doc);
        return NextResponse.json({
            url,
            finalUrl: doc.finalUrl ?? url,
            title: doc.title ?? brief?.title ?? url,
            kind: doc.kind,
            pages: doc.pages ?? null,
            chars: doc.chars ?? doc.text.length,
            brief,
            context
        });
    }
    if (profile) {
        return NextResponse.json({
            url,
            finalUrl: brief.finalUrl ?? url,
            title: brief.title ?? brief.name ?? url,
            kind: "site profile",
            pages: null,
            chars: profile.length,
            brief,
            context: `The user linked ${brief.finalUrl ?? url}. Its full text could not be read just now, but its site profile is below. Answer from it and do not invent details it does not contain.\n\n${profile}`
        });
    }
    const e = docR.reason;
    const status = e instanceof ReadError ? e.status : 502;
    if (!(e instanceof ReadError)) console.error("[chat/read]", e?.message ?? e);
    return err(status, e?.message ?? "The document could not be read.");
}
