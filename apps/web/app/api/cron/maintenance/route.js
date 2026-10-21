import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { reapStaleState } from "@/lib/maintenance";
import { emailSilentNodes } from "@/lib/silent-nodes";

export const dynamic = "force-dynamic";

/**
 * Cron: expire stuck jobs and node commands, mark silent providers offline
 * (see lib/maintenance.js). Called every 5 minutes by the same crontab that
 * calls /api/cron/daily-stats:
 *
 *   curl -fsS -X POST https://infernetprotocol.com/api/cron/maintenance \
 *        -H 'Authorization: Bearer $CRON_SECRET'
 *
 * Auth: CRON_SECRET via Authorization: Bearer or x-cron-secret.
 * ?dry_run=1 returns what would be reaped and changes nothing.
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
    try {
        const supabase = getSupabaseServerClient();
        const reaped = await reapStaleState(supabase, { dryRun });
        if (!dryRun && (reaped.jobs || reaped.commands || reaped.providers || reaped.aggregators)) {
            console.log(`[maintenance] reaped jobs=${reaped.jobs} commands=${reaped.commands} providers=${reaped.providers} aggregators=${reaped.aggregators} probes=${reaped.probes}`);
        }
        let silent = null;
        if (!dryRun) {
            try {
                silent = await emailSilentNodes(supabase);
                if (silent.emailed || silent.errors) console.log(`[maintenance] silent-node emails sent=${silent.emailed} errors=${silent.errors}`);
            } catch (err) {
                console.error("[maintenance] silent-node emails:", err instanceof Error ? err.message : err);
            }
        }
        return NextResponse.json({ data: { ...reaped, silent } });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[maintenance]", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
