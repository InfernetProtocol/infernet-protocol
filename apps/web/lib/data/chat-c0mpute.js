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
