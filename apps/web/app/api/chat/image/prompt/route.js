import { NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { findDocumentUrls } from "@/lib/doc-urls";
import { siteBrief } from "@/lib/site-brief";
import { readDocument } from "@/lib/read-url";
import { MAX_IMAGE_PROMPT_CHARS } from "@/lib/billing/image";
import { writeImagePrompt } from "@/lib/image-prompt-writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/chat/image/prompt  { prompt }  ->  { prompt, writer, documents }
 *
 * For an image request that links pages: reads each link (pit.world's site
 * record + the page's meta and colors, and the page text through readm3; every
 * link is also queued in pit.world's crawler) and writes the prompt the image
 * model gets, doing what the user asked with the link. Branding goes in only
 * when the request is about the brand. A request with no link comes back as is.
 */

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });
const err = (status, error) => NextResponse.json({ error }, { status });

export async function POST(request) {
    const r = limit.check(getClientIp(request));
    if (!r.ok) return err(429, "Link reading limit reached for now. Try again later.");

    let payload;
    try { payload = await request.json(); } catch { return err(400, "Invalid JSON body"); }
    const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
    if (!prompt || prompt.length > MAX_IMAGE_PROMPT_CHARS) return err(400, `Prompt must contain 1 to ${MAX_IMAGE_PROMPT_CHARS} characters`);

    const urls = findDocumentUrls(prompt);
    if (!urls.length) return NextResponse.json({ prompt, writer: "none", documents: [], failed: [] });

    const sources = await Promise.all(urls.map(async (url) => {
        const [briefR, docR] = await Promise.allSettled([siteBrief(url), readDocument(url)]);
        return {
            url,
            brief: briefR.status === "fulfilled" ? briefR.value : null,
            text: docR.status === "fulfilled" ? docR.value.text : null,
            title: docR.status === "fulfilled" ? docR.value.title : null
        };
    }));
    const { prompt: written, writer } = await writeImagePrompt(prompt, sources);
    const read = sources.filter((s) => s.brief || s.text);
    return NextResponse.json({
        prompt: written,
        writer,
        documents: read.map((s) => ({
            url: s.brief?.finalUrl ?? s.url,
            title: s.title ?? s.brief?.title ?? s.brief?.name ?? s.url,
            kind: s.brief?.record ? "pit.world site record" : s.text ? "page" : "site profile"
        })),
        failed: sources.filter((s) => !s.brief && !s.text).map((s) => s.url)
    });
}
