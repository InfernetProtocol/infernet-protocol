/**
 * Fail a chat request over to another node when the node it landed on
 * cannot answer, before the caller has seen a single token.
 *
 * Two things count as "cannot answer":
 *   - an `error` event before the first token (an Ollama 404 for a model the
 *     node does not have, an engine crash on load, ...);
 *   - a `meta` event reporting the `stub` engine: a daemon with no reachable
 *     inference backend answers with canned text ("This is a stub response
 *     from the provider daemon ..."), which is not an answer.
 *
 * The abandoned job is marked failed first, so the node's later completion
 * is a no-op: nobody is charged for it and the node earns nothing.
 *
 * Pure (dependencies injected) so it is testable without Supabase.
 */

export const MAX_CHAT_ATTEMPTS = 3;

/** Why this pre-token event means the node cannot answer, or null. */
export function abandonReason(ev) {
    if (ev?.type === "error") return ev.data?.message ?? "engine error";
    if (ev?.type === "meta" && ev.data?.engine === "stub") {
        return "node has no inference engine (stub backend)";
    }
    return null;
}

/**
 * Yield the job's events like streamJobEvents does, moving to a new job on
 * another node while nothing has been sent yet.
 *
 * @param {{ id: string, provider_id?: string|null }} first
 * @param {{
 *   stream: (jobId: string) => AsyncIterable<{ type: string, data?: any }>,
 *   retry: (excludeProviderIds: string[]) => Promise<{ id: string, provider_id?: string|null } | null>,
 *   abandon: (job: object, reason: string) => Promise<void>,
 *   maxAttempts?: number,
 *   log?: (msg: string) => void
 * }} deps
 */
export async function* failoverEvents(first, { stream, retry, abandon, maxAttempts = MAX_CHAT_ATTEMPTS, log = () => {} }) {
    let job = first;
    const tried = [];
    for (let attempt = 1; ; attempt += 1) {
        if (job.provider_id) tried.push(job.provider_id);
        let started = false;
        let failure = null;
        for await (const ev of stream(job.id)) {
            if (!started) {
                const reason = abandonReason(ev);
                if (reason) {
                    failure = reason;
                    break;
                }
                if (ev.type === "token") started = true;
            }
            yield ev;
            if (ev.type === "done" || ev.type === "error") return;
        }
        if (!failure) return;

        try {
            await abandon(job, failure);
        } catch {
            // Best effort: the job may already be failed by its node.
        }
        // A hosted-fallback job has no provider to exclude; never loop on it.
        let next = null;
        if (attempt < maxAttempts && job.provider_id) {
            next = await retry([...tried]).catch(() => null);
        }
        if (!next) {
            yield { type: "error", data: { message: failure } };
            return;
        }
        log(`[chat-failover] job ${job.id} on ${job.provider_id}: ${failure}; retrying as ${next.id} on ${next.provider_id ?? "fallback"}`);
        job = next;
    }
}
