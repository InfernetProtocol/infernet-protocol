import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { encryptJSON, decryptJSON } from "@/lib/encrypt";
import { retainedSpec } from "@/lib/reservations/house-lane";

/**
 * No-retain jobs (house lane, migration 20261122220000): the prompt, the
 * answer and the token stream exist only while the request runs. The daemon
 * reads the prompt from jobs.input_spec and streams tokens through job_events,
 * so both are written; this removes them the moment the request is over.
 *
 * What survives is what billing needs and nothing else: the token counts and
 * the billing mode in input_spec, the job row's model / provider / timestamps,
 * and the ledger charge. Never throws: a failed purge is retried by the sweep.
 */
export async function purgeJobContent(jobId, { supabase = getSupabaseServerClient() } = {}) {
    if (!jobId) return { purged: false, reason: "no_job" };
    try {
        const { data: job, error } = await supabase
            .from("jobs")
            .select("id, input_spec, no_retain, result")
            .eq("id", jobId)
            .maybeSingle();
        if (error) throw error;
        if (!job) return { purged: false, reason: "not_found" };
        if (!job.no_retain) return { purged: false, reason: "retained_job" };

        let spec = null;
        try { spec = decryptJSON(job.input_spec); } catch { /* unreadable: keep nothing */ }
        const patch = {
            input_spec: encryptJSON(retainedSpec(spec)),
            content_purged_at: new Date().toISOString()
        };
        if (job.result !== null && job.result !== undefined) patch.result = encryptJSON({ redacted: true });

        const { error: delErr } = await supabase.from("job_events").delete().eq("job_id", jobId);
        if (delErr) throw delErr;
        const { error: upErr } = await supabase.from("jobs").update(patch).eq("id", jobId);
        if (upErr) throw upErr;
        return { purged: true };
    } catch (err) {
        console.warn(`[retention] purge failed for job ${jobId}: ${err?.message ?? err}`);
        return { purged: false, reason: String(err?.message ?? err) };
    }
}

/**
 * Purge what a crash or a dropped connection left behind: no-retain jobs that
 * finished (or are clearly dead) but still hold content. Run from the
 * per-minute reservations cron.
 */
export async function sweepUnretainedJobs({ supabase = getSupabaseServerClient(), now = Date.now(), limit = 200 } = {}) {
    const finishedBefore = new Date(now - 2 * 60_000).toISOString();
    const deadBefore = new Date(now - 30 * 60_000).toISOString();
    const { data, error } = await supabase
        .from("jobs")
        .select("id, status, updated_at, created_at")
        .eq("no_retain", true)
        .is("content_purged_at", null)
        .or(`and(status.in.(completed,failed,cancelled),updated_at.lt.${finishedBefore}),created_at.lt.${deadBefore}`)
        .order("created_at", { ascending: true })
        .limit(limit);
    if (error) {
        // Before the migration the column does not exist: nothing to sweep.
        if (/no_retain|content_purged_at/.test(error.message ?? "")) return { swept: 0, skipped: "no_column" };
        throw error;
    }
    let swept = 0;
    for (const row of data ?? []) {
        const r = await purgeJobContent(row.id, { supabase });
        if (r.purged) swept += 1;
    }
    return { swept, candidates: (data ?? []).length };
}
