import { NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { buildWebContext, QUERY_MAX_LEN } from "@/lib/web-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/chat/web  { query }  ->  { query, sources, context }
 *
 * Web search for the chat playground (lib/web-search.js). The browser prepends
 * `context` to the conversation as a system message, so this works for
 * end-to-end encrypted chats as well. Each call spends one search credit and
 * up to three page reads, hence the per-IP limit and the daily cap.
 */

// Same order as /api/chat's 20 messages per IP per hour.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 15 });
const DAILY_CAP = Number.parseInt(process.env.WEB_SEARCH_DAILY_CAP ?? "500", 10);
const daily = { day: "", count: 0 };

function err(status, error) {
    return NextResponse.json({ error }, { status });
}

export async function POST(request) {
    const r = limit.check(getClientIp(request));
    if (!r.ok) return err(429, "Web search limit reached for now. Try again later, or turn web search off.");

    let payload;
    try { payload = await request.json(); } catch { return err(400, "Invalid JSON body"); }
    const query = typeof payload?.query === "string" ? payload.query.replace(/\s+/g, " ").trim().slice(0, QUERY_MAX_LEN) : "";
    if (!query) return err(400, "query is required");

    const today = new Date().toISOString().slice(0, 10);
    if (daily.day !== today) { daily.day = today; daily.count = 0; }
    if (daily.count >= DAILY_CAP) return err(429, "Web search is at its daily limit. It resets at 00:00 UTC.");
    daily.count += 1;

    try {
        return NextResponse.json(await buildWebContext(query));
    } catch (e) {
        console.error("[chat/web]", e?.message ?? e);
        return err(502, "Web search failed. Try again, or turn web search off.");
    }
}
