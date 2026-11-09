import { NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { findDocumentUrls } from "@/lib/doc-urls";
import { siteBrief } from "@/lib/site-brief";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/chat/site  { url }  ->  { brief }
 *
 * What the chat knows about a linked site (name, tagline, description, topics,
 * logo, share image, brand colors) from pit.world's index and the page itself,
 * for image mode to write an on-brand prompt. The URL is also queued in
 * pit.world's crawler so the whole site gets indexed.
 */

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });
const err = (status, error) => NextResponse.json({ error }, { status });

export async function POST(request) {
    const r = limit.check(getClientIp(request));
    if (!r.ok) return err(429, "Link reading limit reached for now. Try again later.");

    let payload;
    try { payload = await request.json(); } catch { return err(400, "Invalid JSON body"); }
    const [url] = findDocumentUrls(typeof payload?.url === "string" ? payload.url.slice(0, 2048) : "");
    if (!url) return err(400, "url must be an http(s) link");

    try {
        const brief = await siteBrief(url);
        if (!brief) return err(422, "Nothing could be read from that link.");
        return NextResponse.json({ brief });
    } catch (e) {
        console.error("[chat/site]", e?.message ?? e);
        return err(502, "The link could not be read.");
    }
}
