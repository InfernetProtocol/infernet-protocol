/**
 * A chat job its node turned away (busy: Ollama queue full, the engine
 * restarting, the daemon restarting for an update, a timeout) goes back
 * through the queue, at the BACK, never handed straight to another node
 * (Anthony, 2026-11-18: "just add it to the back of the queue ... otherwise
 * we could get a recursive loop blocking if no nodes exist"). It is assigned
 * like a new job: the provider the normal picker chooses for the same model
 * (free nodes first, the fastest among them, CPU nodes included), else the
 * node that turned it away. Back of the queue: requeue sets assigned_at, and
 * daemons poll assigned jobs by assigned_at (node-api pollJobsForNode).
 *
 * After INFERNET_MAX_REQUEUES (default 3) turn-aways the job ends with
 * NETWORK_BUSY_MESSAGE ("if there's no nodes available after 3 queues tell
 * the user and end").
 *
 * Pure: the database work is in lib/data/node-api.js requeueJobForNode.
 */

export const DEFAULT_MAX_REQUEUES = 3;

/** The terminal error after the last requeue (Anthony's wording, exact). */
export const NETWORK_BUSY_MESSAGE = "Network is busy. Run a node or wait.";
/** Where "run a node" is explained; sent beside the message, never in it. */
export const RUN_A_NODE_URL = "https://infernetprotocol.com/docs";

/** INFERNET_MAX_REQUEUES, else DEFAULT_MAX_REQUEUES (0 = never requeue). */
export function maxRequeues(env = process.env) {
    const n = Number.parseInt(env?.INFERNET_MAX_REQUEUES ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_REQUEUES;
}

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
 *   target?: object|null,    the provider the normal picker chooses for the model
 *   max?: number             requeue cap
 * }} input
 * @returns {{ requeue: boolean, end?: boolean, reason: string, to?: string, moved?: boolean }}
 *   end: stop here and fail the job with NETWORK_BUSY_MESSAGE.
 */
export function requeueDecision({ job, tokens, provider, target = null, max = DEFAULT_MAX_REQUEUES }) {
    if (!job || (job.type && job.type !== "chat")) return { requeue: false, reason: "not_chat" };
    if (!["assigned", "running"].includes(job.status)) return { requeue: false, reason: "not_in_flight" };
    if (job.provider_id !== provider?.id) return { requeue: false, reason: "not_this_provider" };
    if (tokens > 0) return { requeue: false, reason: "answer_started" };
    const count = Number(job.input_spec?.requeues) || 0;
    if (count >= max) return { requeue: false, end: true, reason: "too_many_requeues" };
    // Bound to this node: a reservation, an E2E job sealed to its model key,
    // or a batch item.
    const pinned = Boolean(job.reservation_id || job.client_pubkey || job.batch_item_id);
    if (!pinned && target && target.id && target.id !== provider.id) {
        return { requeue: true, reason: "back_of_queue", to: target.id, moved: true };
    }
    return { requeue: true, reason: "back_of_queue", to: provider.id, moved: false };
}
