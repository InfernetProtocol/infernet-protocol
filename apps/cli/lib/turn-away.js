/**
 * Busy-type failures: the node turns a chat job away instead of failing it,
 * and the control plane puts it back at the front of the queue
 * (POST /api/v1/node/jobs/<id>/requeue, apps/web/lib/routing/requeue.js,
 * which keeps the same pattern). Anthony, 2026-11-18: "if it turns away a job
 * send it back to the front of the queue".
 */

const TURN_AWAY_RE = /restarting for self-update|server busy|too many requests|HTTP 429|HTTP 503|queue (?:is )?full|no free slot|no inference engine reachable|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|timed? ?out/i;

export function isTurnAwayError(message) {
    return typeof message === 'string' && TURN_AWAY_RE.test(message);
}

/** How long this daemon leaves a job it turned away before taking it again. */
export const TURN_AWAY_BACKOFF_MS = 15_000;

/**
 * Ask the control plane to requeue `jobId`. Resolves true when it did (the
 * caller must then neither post an error nor fail the job), false when the
 * job must fail as before (answer already streaming, too many turn-aways, or
 * a control plane without the endpoint).
 */
export async function requeueTurnedAway(client, jobId, reason) {
    if (typeof client?.requeueJob !== 'function') return false;
    try {
        const res = await client.requeueJob(jobId, reason);
        const data = res?.data ?? res;
        return data?.requeued === true;
    } catch {
        return false;
    }
}
