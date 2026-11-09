import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { decryptJSON } from "@/lib/encrypt";
import { matchServedModel } from "@/lib/model-names";
import { rebalanceDecision } from "@/lib/routing/smart-pick";
import { pickChatProvider } from "@/lib/data/chat";

/**
 * Move a chat job that is stuck in a provider's queue to a provider with a
 * free slot. The decision (lib/routing/smart-pick.js rebalanceDecision) only
 * moves a job that has certainly not started: its node went silent, or it is
 * queued behind at least `concurrency cap` older jobs on that node.
 *
 * Moving is one conditional UPDATE of provider_id (only while the job is
 * still 'assigned' to the old provider). The old daemon is then fenced off:
 * the node API rejects its events and its completion for a job no longer
 * assigned to it. If the old provider managed to emit an event between the
 * check and the update, the move is undone.
 *
 * Called while a client waits on the stream (lib/data/chat-stream.js and
 * /api/chat/stream/[jobId]) and by the maintenance cron for everyone else.
 * Never throws.
 *
 * @returns {Promise<{ moved: boolean, reason: string, from?: string, to?: string }>}
 */
export async function rebalanceChatJob(jobId, { supabase = getSupabaseServerClient(), now = Date.now() } = {}) {
    try {
        const { data: row, error } = await supabase.from("jobs").select("*").eq("id", jobId).maybeSingle();
        if (error || !row) return { moved: false, reason: error ? "job_lookup_failed" : "not_found" };
        if (row.type && row.type !== "chat") return { moved: false, reason: "not_chat" };
        const job = { ...row, input_spec: safeDecrypt(row.input_spec) };
        if (job.status !== "assigned" || !job.provider_id) return { moved: false, reason: "not_assigned" };

        const events = await countEvents(supabase, jobId);
        if (events === null) return { moved: false, reason: "events_lookup_failed" };

        const { data: provider } = await supabase
            .from("providers")
            .select("id, status, disabled_at, last_seen, specs, trust_tier")
            .eq("id", job.provider_id)
            .maybeSingle();

        const since = new Date(now - 15 * 60 * 1000).toISOString();
        const { count: olderAssigned, error: olderErr } = await supabase
            .from("jobs")
            .select("id", { count: "exact", head: true })
            .eq("provider_id", job.provider_id)
            .eq("status", "assigned")
            .neq("id", jobId)
            .lt("created_at", job.created_at)
            .gte("created_at", since);
        if (olderErr) return { moved: false, reason: "queue_lookup_failed" };

        const decision = rebalanceDecision({ job, events, provider: provider ?? null, olderAssigned: olderAssigned ?? 0, now });
        if (!decision.move) return { moved: false, reason: decision.reason };

        // Never route below the trust tier the original pick had to meet. The
        // tier a client asked for is not stored, so the original provider's
        // tier stands in for it.
        const minTrustTier = provider?.trust_tier && provider.trust_tier !== "public" ? provider.trust_tier : undefined;
        const target = await pickChatProvider({
            modelName: job.model_name ?? undefined,
            minTrustTier,
            excludeProviderIds: [job.provider_id],
            requireFreeSlot: true
        });
        if (!target) return { moved: false, reason: `${decision.reason}:no_free_provider` };

        const servedModel = job.model_name
            ? (matchServedModel(target.specs?.served_models, job.model_name) ?? job.model_name)
            : job.model_name;
        const stamp = new Date(now).toISOString();
        const { data: moved, error: moveErr } = await supabase
            .from("jobs")
            .update({
                provider_id: target.id,
                model_name: servedModel ?? null,
                title: servedModel ? `chat:${servedModel}` : job.title,
                assigned_at: stamp,
                updated_at: stamp
            })
            .eq("id", jobId)
            .eq("provider_id", job.provider_id)
            .eq("status", "assigned")
            .select("id")
            .maybeSingle();
        if (moveErr || !moved) return { moved: false, reason: "changed_meanwhile" };

        // The old node may have started in the gap between the check and the
        // move. Its output is already in job_events, so put the job back.
        const after = await countEvents(supabase, jobId);
        if (after !== 0) {
            await supabase
                .from("jobs")
                .update({ provider_id: job.provider_id, model_name: job.model_name, title: job.title, assigned_at: job.assigned_at, updated_at: stamp })
                .eq("id", jobId)
                .eq("provider_id", target.id)
                .eq("status", "assigned");
            return { moved: false, reason: "started_meanwhile" };
        }

        console.log(`[rebalance] chat job ${jobId} ${decision.reason}: ${job.provider_id} -> ${target.id}`);
        return { moved: true, reason: decision.reason, from: job.provider_id, to: target.id };
    } catch (err) {
        return { moved: false, reason: `error:${err?.message ?? err}` };
    }
}

/**
 * Sweep: every assigned chat job from the last 15 minutes that has waited
 * longer than a minute. For the maintenance cron.
 */
export async function rebalanceStuckChatJobs({ supabase = getSupabaseServerClient(), now = Date.now(), limit = 50 } = {}) {
    const out = { checked: 0, moved: 0 };
    const { data, error } = await supabase
        .from("jobs")
        .select("id")
        .eq("type", "chat")
        .eq("status", "assigned")
        .not("provider_id", "is", null)
        .gte("created_at", new Date(now - 15 * 60 * 1000).toISOString())
        .lte("assigned_at", new Date(now - 60 * 1000).toISOString())
        .order("created_at", { ascending: true })
        .limit(limit);
    if (error) throw new Error(`rebalance sweep: ${error.message}`);
    for (const { id } of data ?? []) {
        out.checked += 1;
        const r = await rebalanceChatJob(id, { supabase, now });
        if (r.moved) out.moved += 1;
    }
    return out;
}

async function countEvents(supabase, jobId) {
    const { count, error } = await supabase
        .from("job_events")
        .select("id", { count: "exact", head: true })
        .eq("job_id", jobId);
    return error ? null : (count ?? 0);
}

function safeDecrypt(v) {
    try {
        return decryptJSON(v) ?? {};
    } catch {
        return {};
    }
}
