import "server-only";
import { isNimConfigured, nimVirtualProvider } from "@infernetprotocol/nim-adapter";
import { encryptJSON } from "@/lib/encrypt";

/**
 * A c0mpute chat job no worker answered: hand it to the hosted fallback when
 * that was allowed when the job was created (input_spec.nim_ok, set only when
 * the caller did not ask for p2p_only and today's fallback cap had room).
 * Rewrites the job row to the fallback model and returns the job to run there,
 * or null when it stays failed.
 */
export async function moveC0mputeJobToNim(supabase, job) {
  const input = job?.input_spec ?? {};
  if (input.nim_ok !== true || !isNimConfigured()) return null;
  const model = nimVirtualProvider().model;
  const { c0mpute_model: _c0, nim_ok: _ok, ...rest } = input;
  const spec = {
    ...rest,
    fallback: "nvidia-nim",
    requested_model: input.requested_model ?? input.c0mpute_model ?? job.model_name ?? undefined
  };
  try {
    await supabase
      .from("jobs")
      .update({ model_name: model, title: `chat:${model}`, input_spec: encryptJSON(spec), updated_at: new Date().toISOString() })
      .eq("id", job.id);
  } catch {
    // Best effort: the answer matters more than the row's label.
  }
  console.warn(`[c0mpute-chat] job ${job.id}: no c0mpute worker answered; serving it on the hosted fallback (${model})`);
  return { ...job, model_name: model, input_spec: spec };
}

/** Provider-row node_id for a c0mpute worker, by its libp2p peer id. */
export function c0mputeNodeId(peerId) {
  return `c0mpute:${peerId}`;
}

/** A plausible libp2p peer id (base58), so nothing else lands in providers. */
export function isPeerId(v) {
  return typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(v);
}

/**
 * The providers row standing for c0mpute worker `peerId`, created on its
 * first job. It exists so the worker's jobs and earnings are recorded like a
 * daemon's: status "c0mpute" (never "available", so the daemon picker never
 * selects it) and not public (the provider list is for daemons). Returns the
 * row id, or null when the write fails.
 */
export async function c0mputeProviderId(supabase, peerId) {
  if (!isPeerId(peerId)) return null;
  const nodeId = c0mputeNodeId(peerId);
  const now = new Date().toISOString();
  try {
    const { data: found } = await supabase.from("providers").select("id").eq("node_id", nodeId).maybeSingle();
    if (found?.id) {
      await supabase.from("providers").update({ last_seen: now }).eq("id", found.id);
      return found.id;
    }
    const { data: made, error } = await supabase
      .from("providers")
      .insert({
        node_id: nodeId,
        name: `c0mpute ${peerId.slice(-8)}`,
        status: "c0mpute",
        is_public: false,
        trust_tier: "public",
        last_seen: now,
        specs: { c0mpute_peer: peerId }
      })
      .select("id")
      .single();
    if (error) {
      // Two jobs from a new worker finishing together: the other insert won.
      const { data: again } = await supabase.from("providers").select("id").eq("node_id", nodeId).maybeSingle();
      return again?.id ?? null;
    }
    return made?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Settle a job a c0mpute worker answered: attribute it to that worker's
 * provider row, then charge the buyer and credit the worker its share (the
 * same settleInteractiveJob path a daemon's job takes). Before 2026-11-14 a
 * c0mpute job charged the buyer and credited nobody. Free jobs pay nobody,
 * as on the daemons. Never throws.
 */
export async function settleC0mputeJob(supabase, job, result) {
  const worker = result?.worker ?? null;
  let attributed = job;
  try {
    const providerId = await c0mputeProviderId(supabase, worker);
    if (providerId) {
      await supabase.from("jobs").update({ provider_id: providerId }).eq("id", job.id);
      attributed = { ...job, provider_id: providerId };
    }
  } catch {
    // Attribution is best effort; the charge below still runs.
  }
  if (!attributed?.billed_user_id) return { billed: false, reason: "no_buyer" };
  try {
    const { settleInteractiveJob } = await import("@/lib/data/interactive-billing");
    if (attributed.provider_id) return await settleInteractiveJob({ supabase, job: attributed, result });
    // No worker to credit (an old bridge without `worker`): charge only.
    const { chargeInteractiveJob } = await import("@/lib/data/interactive-billing");
    return await chargeInteractiveJob({ job: attributed, result });
  } catch (err) {
    console.warn(`[c0mpute-chat] settle failed for job ${job?.id}: ${err?.message ?? err}`);
    return { billed: false, reason: String(err?.message ?? err) };
  }
}

/**
 * A c0mpute chat job no worker answered: hand it to an Infernet provider
 * daemon serving the model before anything else (the hosted fallback is
 * billed and comes after). Keeps the job id, so the caller's stream carries
 * on in the provider path. Returns the reassigned job, or null when no daemon
 * can take it.
 */
export async function moveC0mputeJobToProvider(supabase, job) {
  const input = job?.input_spec ?? {};
  const model = input.c0mpute_model ?? job?.model_name ?? null;
  try {
    const { pickChatProvider } = await import("@/lib/data/chat");
    const { matchServedModel } = await import("@/lib/model-names");
    const provider = await pickChatProvider({ modelName: model ?? undefined, reserve: true });
    if (!provider) return null;
    const served = (model ? matchServedModel(provider.specs?.served_models, model) : null) ?? model;
    const { fallback: _f, c0mpute_model: _c0, nim_ok: _ok, ...rest } = input;
    const spec = { ...rest };
    const now = new Date().toISOString();
    const patch = {
      provider_id: provider.id,
      status: "assigned",
      assigned_at: now,
      updated_at: now,
      model_name: served ?? null,
      title: served ? `chat:${served}` : "chat",
      input_spec: encryptJSON(spec)
    };
    const { error } = await supabase.from("jobs").update(patch).eq("id", job.id);
    if (error) return null;
    console.warn(`[c0mpute-chat] job ${job.id}: no c0mpute worker answered; moved to provider ${provider.name ?? provider.id}`);
    return { ...job, ...patch, input_spec: spec };
  } catch (err) {
    console.warn(`[c0mpute-chat] move to provider failed for job ${job?.id}: ${err?.message ?? err}`);
    return null;
  }
}
