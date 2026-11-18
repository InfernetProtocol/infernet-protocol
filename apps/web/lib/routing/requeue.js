/**
 * A chat job its node turned away (busy: Ollama queue full, the engine
 * restarting, the daemon restarting for an update) goes back to the FRONT of
 * the queue: same job row, so the same created_at, and daemons poll their
 * assigned jobs oldest first (node-api pollJobsForNode). From there it goes
 * to the first capable node with a free slot (same model; CPU nodes count,
 * "it could be a cpu node if that's all that's available"; the fastest when
 * several are free, by smart-pick); with none free it stays first in line on
 * the node that turned it away. Never a different model.
 *
 * Anthony, 2026-11-18: "if it turns away a job send it back to the front of
 * the queue". Before, the node failed the job, the client failed over and the
 * retry was a new job at the back, often on a CPU node.
 *
 * Pure: the database work is in lib/data/node-api.js requeueJobForNode.
 */

/** After this many turn-aways the job fails as before. */
export const MAX_REQUEUES = 10;

/** Errors that mean "busy, try again", not "cannot serve this". */
const TURN_AWAY_RE = /restarting for self-update|server busy|too many requests|HTTP 429|HTTP 503|queue (?:is )?full|no free slot|no inference engine reachable|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|timed? ?out/i;

export function isTurnAwayError(message) {
    return typeof message === "string" && TURN_AWAY_RE.test(message);
}

/**
 * @param {{
 *   job: { type?: string, status: string, provider_id: string, reservation_id?: string|null,
 *          client_pubkey?: string|null, batch_item_id?: string|null, input_spec?: object },
 *   tokens: number,          token events already sent for the job
 *   provider: object,        the provider row that turned it away
 *   target?: object|null     the best provider with a free slot serving the same model, if any
 * }} input
 * @returns {{ requeue: boolean, reason: string, to?: string, moved?: boolean }}
 */
export function requeueDecision({ job, tokens, provider, target = null }) {
    if (!job || (job.type && job.type !== "chat")) return { requeue: false, reason: "not_chat" };
    if (!["assigned", "running"].includes(job.status)) return { requeue: false, reason: "not_in_flight" };
    if (job.provider_id !== provider?.id) return { requeue: false, reason: "not_this_provider" };
    if (tokens > 0) return { requeue: false, reason: "answer_started" };
    const count = Number(job.input_spec?.requeues) || 0;
    if (count >= MAX_REQUEUES) return { requeue: false, reason: "too_many_requeues" };
    // Bound to this node: a reservation, an E2E job sealed to its model key,
    // or a batch item.
    const pinned = Boolean(job.reservation_id || job.client_pubkey || job.batch_item_id);
    if (!pinned && target && target.id && target.id !== provider.id) {
        return { requeue: true, reason: "moved_to_free_node", to: target.id, moved: true };
    }
    return { requeue: true, reason: "front_of_queue", to: provider.id, moved: false };
}
