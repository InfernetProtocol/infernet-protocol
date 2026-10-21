import "server-only";

/**
 * Stale-state reaper, run by POST /api/cron/maintenance.
 *
 * Three kinds of row could get stuck forever, and the daily report counted
 * every one of them as live work:
 *
 *   jobs           pending / assigned / running that nobody will ever finish
 *                  (a provider that went away mid-job, or a request no
 *                  provider could take). 91 had sat 'pending' since April.
 *   node_commands  pending / running that the node never picked up or never
 *                  answered (model installs on nodes that went offline).
 *   providers      status 'available' long after the last heartbeat. A live
 *                  daemon heartbeats every 30 s and every heartbeat sets the
 *                  status back to 'available', so flipping a silent node to
 *                  'offline' is undone the moment it comes back.
 *   aggregators    the same rule as providers.
 *
 * Aggregator probe rows (provider_probes) older than a week are deleted.
 *
 * Each rule is a single conditional UPDATE, so a row that moved on between
 * the read and the write is never touched.
 */

const MINUTE = 60_000;

export const REAP_RULES = {
    // A chat job streams in seconds to minutes. An hour without an update
    // means the provider is gone.
    jobAfterMs: 60 * MINUTE,
    // Model installs can pull tens of GB; a day is generous.
    commandAfterMs: 24 * 60 * MINUTE,
    // 20 missed heartbeats.
    providerAfterMs: 10 * MINUTE,
    // Aggregator verification history kept for /nodes/[id].
    probeRetentionMs: 7 * 24 * 60 * MINUTE
};

function errMessage(error) {
    if (error && typeof error === "object" && "message" in error) return String(error.message);
    return String(error);
}

async function reap(query, what) {
    const { data, error } = await query.select("id");
    if (error) throw new Error(`maintenance: ${what} failed: ${errMessage(error)}`);
    return Array.isArray(data) ? data.length : 0;
}

async function countOnly(query, what) {
    const { count, error } = await query;
    if (error) throw new Error(`maintenance: ${what} failed: ${errMessage(error)}`);
    return typeof count === "number" ? count : 0;
}

/**
 * @param {object} supabase  service-role client
 * @param {{ now?: Date, dryRun?: boolean, rules?: typeof REAP_RULES }} [opts]
 * @returns {Promise<{ jobs: number, commands: number, providers: number, aggregators: number, probes: number, dryRun: boolean }>}
 */
export async function reapStaleState(supabase, { now = new Date(), dryRun = false, rules = REAP_RULES } = {}) {
    const before = (ms) => new Date(now.getTime() - ms).toISOString();
    const stamp = now.toISOString();
    const jobCutoff = before(rules.jobAfterMs);
    const commandCutoff = before(rules.commandAfterMs);
    const providerCutoff = before(rules.providerAfterMs);

    if (dryRun) {
        const head = (table) => supabase.from(table).select("*", { count: "exact", head: true });
        const [jobs, commands, providers, aggregators, probes] = await Promise.all([
            countOnly(head("jobs").in("status", ["pending", "assigned", "running"]).lt("updated_at", jobCutoff), "jobs"),
            countOnly(head("node_commands").in("status", ["pending", "running"]).lt("issued_at", commandCutoff), "node_commands"),
            countOnly(head("providers").eq("status", "available").lt("last_seen", providerCutoff), "providers"),
            countOnly(head("aggregators").eq("status", "available").lt("last_seen", providerCutoff), "aggregators"),
            countOnly(head("provider_probes").lt("probed_at", before(rules.probeRetentionMs)), "provider_probes")
        ]);
        return { jobs, commands, providers, aggregators, probes, dryRun: true };
    }

    const jobs = await reap(
        supabase
            .from("jobs")
            .update({
                status: "failed",
                error: "expired: no provider finished this job within an hour",
                completed_at: stamp,
                updated_at: stamp
            })
            .in("status", ["pending", "assigned", "running"])
            .lt("updated_at", jobCutoff),
        "jobs"
    );

    const commands = await reap(
        supabase
            .from("node_commands")
            .update({
                status: "failed",
                error: "timed out: the node did not finish this command within 24 hours",
                completed_at: stamp
            })
            .in("status", ["pending", "running"])
            .lt("issued_at", commandCutoff),
        "node_commands"
    );

    const providers = await reap(
        supabase
            .from("providers")
            .update({ status: "offline" })
            .eq("status", "available")
            .lt("last_seen", providerCutoff),
        "providers"
    );

    const aggregators = await reap(
        supabase
            .from("aggregators")
            .update({ status: "offline" })
            .eq("status", "available")
            .lt("last_seen", providerCutoff),
        "aggregators"
    );

    const probes = await reap(
        supabase.from("provider_probes").delete().lt("probed_at", before(rules.probeRetentionMs)),
        "provider_probes"
    );

    return { jobs, commands, providers, aggregators, probes, dryRun: false };
}
