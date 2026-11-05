import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { roundUsd } from "@/lib/earnings/core";

/**
 * What ONE account has paid the platform in fees.
 *
 * Every charge splits the same way: the provider keeps amount_usd, the house
 * keeps fee_usd. So a customer's fees are the fee_usd of the earning rows
 * belonging to the jobs they paid for. There is no separate fee ledger to
 * reconcile, which is the whole reason it is read this way.
 *
 * Two kinds of job belong to an account:
 *   interactive  jobs.billed_user_id is them (lib/data/interactive-billing.js)
 *   batch        an inference_batch of theirs, whose items carry job ids
 *
 * Never throws. A fee panel that fails must not take the page down, so it
 * degrades to null and the caller shows nothing.
 */

function db(supabase) {
    return supabase ?? getSupabaseServerClient();
}

const CHUNK = 500;

/** provider_earnings for a set of job ids, in chunks Postgres is happy with. */
async function earningsForJobs(client, jobIds) {
    const out = [];
    for (let i = 0; i < jobIds.length; i += CHUNK) {
        const slice = jobIds.slice(i, i + CHUNK);
        const { data, error } = await client
            .from("provider_earnings")
            .select("job_id, status, kind, fee_usd, gross_usd, amount_usd")
            .in("job_id", slice);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
    }
    return out;
}

export async function getAccountFees(userId, supabase) {
    if (!userId) return null;
    try {
        const client = db(supabase);

        // Interactive jobs this account was billed for.
        const { data: mine, error: jErr } = await client
            .from("jobs")
            .select("id")
            .eq("billed_user_id", userId)
            .limit(5000);
        if (jErr && !/billed_user_id/.test(jErr.message ?? "")) throw new Error(jErr.message);
        const jobIds = new Set((mine ?? []).map((r) => r.id).filter(Boolean));

        // Batch jobs: their batches, then the items' job ids.
        try {
            const { data: batches } = await client
                .from("inference_batches")
                .select("id")
                .eq("user_id", userId)
                .limit(1000);
            const batchIds = (batches ?? []).map((b) => b.id).filter(Boolean);
            if (batchIds.length > 0) {
                const { data: items } = await client
                    .from("inference_batch_items")
                    .select("job_id")
                    .in("batch_id", batchIds)
                    .limit(20000);
                for (const it of items ?? []) if (it?.job_id) jobIds.add(it.job_id);
            }
        } catch {
            // Before the paid-batch migration these tables do not exist. The
            // interactive total is still correct on its own.
        }

        if (jobIds.size === 0) {
            return { fees_usd: 0, spent_usd: 0, jobs: 0, billed_jobs: 0 };
        }

        const rows = await earningsForJobs(client, [...jobIds]);
        const confirmed = rows.filter((r) => r.status === "confirmed");
        const fee = (r) => Number(r.fee_usd) || 0;
        // What the customer paid is the gross: the provider's share plus the
        // fee. amount_usd alone would understate it by exactly the fee.
        const gross = (r) => Number(r.gross_usd) || (Number(r.amount_usd) || 0) + fee(r);
        const billed = confirmed.filter((r) => gross(r) > 0);

        return {
            fees_usd: roundUsd(confirmed.reduce((a, r) => a + fee(r), 0)),
            spent_usd: roundUsd(billed.reduce((a, r) => a + gross(r), 0)),
            jobs: jobIds.size,
            billed_jobs: new Set(billed.map((r) => r.job_id)).size
        };
    } catch (err) {
        console.warn(`[account-fees] ${userId}: ${err?.message ?? err}`);
        return null;
    }
}
