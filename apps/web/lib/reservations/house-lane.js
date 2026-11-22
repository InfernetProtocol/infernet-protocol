/**
 * House lane: pure helpers (no I/O), shared by lib/reservations/serve.js and
 * lib/data/job-retention.js, and unit-tested on their own.
 *
 * A house-lane reservation serves confidential requests on a node the house
 * operates. Who can see what:
 *   - the calling app (a trusted client such as c0mpute) sends the prompt;
 *   - Infernet holds it encrypted at rest only while the job runs, then
 *     purges the prompt, answer and token stream (job-retention.js);
 *   - only the reservation's pinned node decrypts and runs it: no other
 *     provider, no c0mpute auction, no hosted fallback, ever.
 */

/** The fields of a no-retain job's input_spec that survive the purge: billing counts only. */
export function retainedSpec(spec) {
    const s = spec && typeof spec === "object" ? spec : {};
    const keep = { no_retain: true, purged: true };
    if (typeof s.billing === "string") keep.billing = s.billing;
    if (Number.isFinite(s.input_tokens)) keep.input_tokens = s.input_tokens;
    if (Number.isFinite(s.max_tokens)) keep.max_tokens = s.max_tokens;
    return keep;
}

/**
 * May this billing decision run on the house lane? The lane is paid only:
 * a balance (topped up or earned) or the operator's admin account. The free
 * tier, an unlinked caller and a degraded lookup are refused, never served.
 */
export function houseLaneBillingOk(billing) {
    return billing?.mode === "balance" || billing?.mode === "admin";
}

/** The 402 a caller without a balance gets on the house lane. */
export function houseLaneBalanceError(billing) {
    return {
        status: 402,
        code: "balance_required",
        message: "this private (house-lane) request is paid only: add funds to your compute balance",
        extra: {
            reason: "balance_required",
            spendable_usd: billing?.spendable_usd ?? "0.000000"
        }
    };
}
