import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { collectDailyStats, renderDailyStats, sendDailyStatsEmail } from "@/lib/daily-stats";

export const dynamic = "force-dynamic";

/**
 * Cron: the Infernet Protocol daily stats email (08:00 UTC, to
 * anthony@profullstack.com). Called by the DigitalOcean droplet's crontab:
 *
 *   curl -fsS -X POST https://infernetprotocol.com/api/cron/daily-stats \
 *        -H 'Authorization: Bearer $CRON_SECRET'
 *
 * Runs inside the app so it reads the same database and keys the site does.
 * It used to be tooling/daily-stats-email.mjs run on the droplet from a
 * checkout that was never there, so no report was ever sent.
 *
 * Auth: CRON_SECRET via Authorization: Bearer (as /api/cron/cpr) or
 * x-cron-secret. ?dry_run=1 returns the counts as JSON and sends nothing.
 * Any query failure, or an empty core count, is a 500 and NO email goes out.
 */
function authorized(request) {
    const expected = process.env.CRON_SECRET;
    if (!expected) return false;
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const given = request.headers.get("x-cron-secret") || bearer;
    return Boolean(given) && given === expected;
}

export async function POST(request) {
    if (!authorized(request)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const dryRun = new URL(request.url).searchParams.get("dry_run") === "1";

    let stats;
    try {
        stats = await collectDailyStats(getSupabaseServerClient());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[daily-stats] not sent:", message);
        return NextResponse.json({ error: message, sent: false }, { status: 500 });
    }

    const report = renderDailyStats(stats);
    if (dryRun) {
        return NextResponse.json({ sent: false, dry_run: true, subject: report.subject, stats });
    }

    try {
        const id = await sendDailyStatsEmail(report);
        console.log(`[daily-stats] sent ${report.subject} (${id ?? "no id"})`);
        return NextResponse.json({ sent: true, id, subject: report.subject });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[daily-stats] send failed:", message);
        return NextResponse.json({ error: message, sent: false }, { status: 502 });
    }
}
