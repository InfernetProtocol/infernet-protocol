import { NextResponse } from "next/server";
import { activeReservations, recordProbe } from "@/lib/data/reservations";
import { probe } from "@/lib/data/reservation-upstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron: probe the pinned target of every reservation whose window is open and
 * write one row per reservation-minute — whether or not anyone sent traffic.
 * Those rows are the availability evidence the per-hour report is built from.
 * Run every minute from dev2's crontab:
 *
 *   * * * * * curl -fsS -m 55 -X POST https://infernetprotocol.com/api/cron/reservations \
 *        -H "Authorization: Bearer $CRON_SECRET"
 *
 * A minute the cron misses has no row and counts as unconfirmed.
 */
function authorized(request) {
    const expected = process.env.CRON_SECRET;
    if (!expected) return false;
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const given = request.headers.get("x-cron-secret") || bearer;
    return Boolean(given) && given === expected;
}

export async function POST(request) {
    if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const now = new Date();
    try {
        const list = await activeReservations(now);
        const results = await Promise.all(list.map(async (res) => {
            const verdict = await probe(res, now.getTime());
            await recordProbe(res.id, now, verdict);
            return { id: res.id, ok: verdict.ok, latency_ms: verdict.latency_ms, detail: verdict.detail };
        }));
        const failed = results.filter((r) => !r.ok);
        if (failed.length) console.warn(`[reservations] ${failed.length}/${results.length} probes failed`, failed);
        return NextResponse.json({ data: { minute: now.toISOString(), probed: results.length, results } });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[reservations cron]", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
