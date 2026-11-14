import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getJobWithEvents } from "@/lib/data/chat";
import { rebalanceChatJob } from "@/lib/data/chat-rebalance";
import { streamChatCompletion, fallbackName } from "@infernetprotocol/nim-adapter";
import { makeStreamSanitizer, sanitizeText } from "@/lib/sanitize-stream";
import { encryptJSON, decryptJSON } from "@/lib/encrypt";
import { c0mputeJobEvents } from "@/lib/chat/c0mpute-inference";
import { moveC0mputeJobToNim, moveC0mputeJobToProvider, settleC0mputeJob } from "@/lib/data/chat-c0mpute";

/**
 * Async generator that yields normalized job events for a given job:
 *
 *   { type: 'meta' | 'token' | 'done' | 'error', data, id? }
 *
 * Handles both routing paths transparently:
 *   - input_spec.fallback === 'nvidia-nim' → relays the NIM stream and
 *     mirrors events into job_events for the audit trail.
 *   - otherwise → tails job_events via Supabase Realtime for tokens
 *     emitted by the provider daemon.
 *
 * Used by both /api/chat/stream/<jobId> (custom-event SSE) and
 * /v1/chat/completions (OpenAI-format SSE) — the format-specific
 * shaping happens at the route boundary.
 *
 * Generator stops cleanly when:
 *   - 'done' or 'error' event is yielded
 *   - 10-min absolute timeout fires (defends against abandoned connections)
 *   - the consumer's `for await` is broken out of (channel cleanup runs)
 */
const MAX_ALIVE_MS = 10 * 60 * 1000;
const REBALANCE_EVERY_MS = 15_000;

export async function* streamJobEvents(jobId) {
    const supabase = getSupabaseServerClient();

    const { job, events: pre } = await getJobWithEvents(jobId, 0);
    if (!job) {
        yield { type: "error", data: { message: "job not found", jobId } };
        return;
    }

    yield { type: "job", data: job };

    // One sanitizer per stream — strips known training-data-leak tag
    // pairs (e.g. <ip_reminder>...) emitted by contaminated
    // community fine-tunes. Applied to every token + the final 'done'
    // body so the audit trail and the user-visible stream are both
    // clean.
    const sanitizer = makeStreamSanitizer();

    let lastId = 0;
    for (const ev of pre) {
        lastId = Math.max(lastId, ev.id);
        if (ev.event_type === "token") {
            const cleanText = sanitizer.process(ev.data?.text ?? "");
            if (cleanText) {
                yield { type: "token", data: { ...ev.data, text: cleanText }, id: ev.id };
            }
        } else if (ev.event_type === "done") {
            const tail = sanitizer.flush();
            const cleanFull = sanitizeText(ev.data?.text ?? "") + tail;
            yield { type: "done", data: { ...ev.data, text: cleanFull }, id: ev.id };
            return;
        } else {
            yield { type: ev.event_type, data: ev.data, id: ev.id };
            if (ev.event_type === "error") return;
        }
    }

    if (job?.input_spec?.fallback === "nvidia-nim") {
        yield* runNimFallback({ supabase, job });
        return;
    }

    if (job?.input_spec?.fallback === "c0mpute") {
        yield* runC0mputeFallback({ supabase, job, sanitizer });
        return;
    }

    // P2P path — subscribe to Realtime + drain via a small queue.
    const queue = [];
    let resolveNext = null;
    let closed = false;

    const channel = supabase
        .channel(`chat-stream-${jobId}-${Math.random().toString(36).slice(2)}`)
        .on(
            "postgres_changes",
            {
                event: "INSERT",
                schema: "public",
                table: "job_events",
                filter: `job_id=eq.${jobId}`
            },
            (payload) => {
                const ev = payload?.new;
                if (!ev || ev.id <= lastId) return;
                lastId = ev.id;
                queue.push({ type: ev.event_type, data: decryptJSON(ev.data), id: ev.id });
                if (resolveNext) {
                    const r = resolveNext;
                    resolveNext = null;
                    r();
                }
            }
        );
    channel.subscribe();

    const deadline = Date.now() + MAX_ALIVE_MS;
    // While nothing has arrived, check now and then whether the job is stuck
    // in a busy node's queue and another node is free (chat-rebalance.js).
    // A moved job keeps its id, so this stream just keeps listening.
    let started = pre.length > 0;
    let nextRebalanceAt = Date.now() + REBALANCE_EVERY_MS;

    try {
        while (!closed) {
            if (queue.length === 0) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    yield { type: "error", data: { message: "stream timeout" } };
                    return;
                }
                if (!started && Date.now() >= nextRebalanceAt) {
                    nextRebalanceAt = Date.now() + REBALANCE_EVERY_MS;
                    await rebalanceChatJob(jobId, { supabase });
                }
                await new Promise((res) => {
                    resolveNext = res;
                    const t = setTimeout(res, Math.min(remaining, started ? 30_000 : REBALANCE_EVERY_MS));
                    if (typeof t.unref === "function") t.unref();
                });
                continue;
            }
            started = true;
            const ev = queue.shift();
            if (ev.type === "token") {
                const cleanText = sanitizer.process(ev.data?.text ?? "");
                if (cleanText) {
                    yield { type: "token", data: { ...ev.data, text: cleanText }, id: ev.id };
                }
            } else if (ev.type === "done") {
                const tail = sanitizer.flush();
                const cleanFull = sanitizeText(ev.data?.text ?? "") + tail;
                yield { type: "done", data: { ...ev.data, text: cleanFull }, id: ev.id };
                return;
            } else {
                yield ev;
                if (ev.type === "error") return;
            }
        }
    } finally {
        closed = true;
        try { supabase.removeChannel(channel); } catch { /* ignore */ }
    }
}

/**
 * A job sent to c0mpute workers (infernet.inference); see
 * lib/chat/c0mpute-inference.js. Falls over to the hosted fallback when no
 * worker answers and that was allowed (input_spec.nim_ok).
 */
async function* runC0mputeFallback({ supabase, job, sanitizer }) {
    for await (const ev of c0mputeJobEvents(job, {
        insertEvent: (jobId, type, data) => insertJobEvent(supabase, jobId, type, data),
        finalize: (jobId, patch) => finalizeJob(supabase, jobId, patch),
        // Attributes the job to the winning worker and pays it its share.
        charge: (j, result) => settleC0mputeJob(supabase, j, result)
    })) {
        if (ev.type === "token") {
            const cleanText = sanitizer.process(ev.data?.text ?? "");
            if (cleanText) yield { ...ev, data: { ...ev.data, text: cleanText } };
        } else if (ev.type === "done") {
            const tail = sanitizer.flush();
            yield { ...ev, data: { ...ev.data, text: sanitizeText(ev.data?.text ?? "") + tail } };
            return;
        } else if (ev.type === "c0mpute_failed") {
            // No worker answered: an Infernet daemon serving the model next
            // (same job id, so this stream carries on in the provider path),
            // and the billed hosted fallback only after that.
            const moved = await moveC0mputeJobToProvider(supabase, job);
            if (moved) {
                yield* streamJobEvents(job.id);
                return;
            }
            const nimJob = await moveC0mputeJobToNim(supabase, job);
            if (nimJob) {
                yield* runNimFallback({ supabase, job: nimJob });
                return;
            }
            const data = { message: ev.data?.message ?? "c0mpute worker failed" };
            const persisted = await insertJobEvent(supabase, job.id, "error", data);
            await finalizeJob(supabase, job.id, { status: "failed", error: data.message });
            yield { type: "error", data, id: persisted?.id };
            return;
        } else {
            yield ev;
        }
    }
}

async function* runNimFallback({ supabase, job }) {
    const input = job.input_spec ?? {};
    const messages = input.messages ?? [];
    const model = input.nim_model ?? job.model_name ?? undefined;

    const persistedMeta = await insertJobEvent(supabase, job.id, "meta", {
        provider_node_id: "nvidia-nim",
        provider_name: fallbackName(),
        model: model ?? null,
        started_at: new Date().toISOString()
    });
    yield { type: "meta", data: persistedMeta?.data, id: persistedMeta?.id };

    let fullText = "";
    let finalized = false;
    const sanitizer = makeStreamSanitizer();

    try {
        for await (const ev of streamChatCompletion({
            messages,
            model,
            maxTokens: input.max_tokens,
            temperature: input.temperature
        })) {
            if (ev.type === "meta") continue;
            if (ev.type === "token") {
                fullText += ev.data?.text ?? "";
                const cleanText = sanitizer.process(ev.data?.text ?? "");
                const cleanData = cleanText
                    ? { ...ev.data, text: cleanText }
                    : { ...ev.data, text: "" };
                const persisted = await insertJobEvent(supabase, job.id, "token", cleanData);
                if (cleanText) {
                    yield { type: "token", data: cleanData, id: persisted?.id };
                }
            } else if (ev.type === "done") {
                const tail = sanitizer.flush();
                const cleanFull = sanitizeText(fullText) + tail;
                const data = {
                    text: cleanFull,
                    finished_at: ev.data?.finished_at ?? new Date().toISOString()
                };
                const persisted = await insertJobEvent(supabase, job.id, "done", data);
                await finalizeJob(supabase, job.id, {
                    status: "completed",
                    result: { type: "chat", text: fullText, source: "nvidia-nim" }
                });
                await chargeInteractive(job, { type: "chat", text: fullText, source: "nvidia-nim" });
                finalized = true;
                yield { type: "done", data, id: persisted?.id };
                return;
            } else if (ev.type === "error") {
                const persisted = await insertJobEvent(supabase, job.id, "error", ev.data);
                await finalizeJob(supabase, job.id, {
                    status: "failed",
                    error: ev.data?.message ?? "nim error"
                });
                finalized = true;
                yield { type: "error", data: ev.data, id: persisted?.id };
                return;
            }
        }
    } finally {
        if (!finalized) {
            await finalizeJob(supabase, job.id, {
                status: "completed",
                result: { type: "chat", text: fullText, source: "nvidia-nim", incomplete: true }
            });
            await chargeInteractive(job, { type: "chat", text: fullText, source: "nvidia-nim" });
        }
    }
}

async function insertJobEvent(supabase, jobId, eventType, data) {
    try {
        const { data: row, error } = await supabase
            .from("job_events")
            .insert({ job_id: jobId, event_type: eventType, data: encryptJSON(data) })
            .select("id, event_type, data, created_at")
            .single();
        if (error) return null;
        return row ? { ...row, data: decryptJSON(row.data) } : null;
    } catch {
        return null;
    }
}

/**
 * Interactive pay-as-you-go: charge the buyer for a hosted-fallback request.
 * The fallback has no provider to credit, but the house paid a vendor for the
 * tokens, so it is still billed. Idempotent on the job; never throws.
 */
async function chargeInteractive(job, result) {
    if (!job?.billed_user_id) return;
    try {
        const { chargeInteractiveJob } = await import("@/lib/data/interactive-billing");
        await chargeInteractiveJob({ job, result });
    } catch (err) {
        console.warn(`interactive charge failed for job ${job?.id}: ${err?.message ?? err}`);
    }
}

async function finalizeJob(supabase, jobId, { status, result, error }) {
    const now = new Date().toISOString();
    const patch = { status, updated_at: now, completed_at: now };
    if (result !== undefined) patch.result = encryptJSON(result);
    if (error !== undefined) patch.error = error;
    try {
        await supabase.from("jobs").update(patch).eq("id", jobId);
    } catch {
        /* best-effort */
    }
}
