/**
 * Smart routing: send a chat job to the provider expected to FINISH it first.
 * Pure (no DB), so it is unit-tested directly.
 *
 *   1. Load = the larger of the heartbeat's active_jobs and the live count of
 *      assigned/running jobs we routed there (heartbeats lag a burst, and the
 *      daemon reports only the job it is running, never the ones queued
 *      behind it).
 *   2. Concurrency cap = what the node advertises (specs.load.concurrency_cap,
 *      from INFERNET_MAX_CONCURRENT_JOBS), else 1 on a CPU-only node (no VRAM:
 *      CPU Ollama serves one request at a time) and 4 on a GPU node.
 *      Overloaded = load >= cap, or GPU pegged >= 95%. Overloaded nodes rank
 *      after every free one, but can still take queued work up to the queue
 *      limit (max(cap, 4)); past that a node is saturated and routing skips it.
 *   3. Score = speed / (load + 1): a 2.6 tok/s node that is free beats a
 *      5.2 tok/s node already serving a job. Speed is the measured
 *      tokens/second (specs.bench.tokens_per_second_avg); an unmeasured node
 *      is assumed to run at 3/4 of the median measured speed, so it still gets
 *      work (and a measurement) when the measured nodes are busy.
 *   4. Reputation below LOW_REPUTATION demotes a provider to the bottom of its
 *      load group; then higher score, higher reputation, and exact ties are
 *      broken at random so equal nodes share the traffic.
 *
 * Before 2026-11-09 the ranking sorted by speed tier first, so the single
 * fastest CPU node took every job until it had 4 in flight, and the other
 * nodes idled while jobs queued 5-10 minutes behind it.
 */

export const DEFAULT_CONCURRENCY_CAP = 4;
export const CPU_CONCURRENCY_CAP = 1;
/** Jobs a provider may have queued (assigned) before routing skips it. */
export const QUEUE_LIMIT = 4;
export const HIGH_GPU_UTILIZATION_PCT = 95;
const LOW_REPUTATION = 20;
const UNMEASURED_SPEED_RATIO = 0.75;
const UNMEASURED_SPEED_DEFAULT = 1;

function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** True when the heartbeat says the node has no GPU memory at all. */
export function isCpuOnly(p) {
    const vram = num(p?.specs?.load?.vram?.total_gb);
    return vram !== null && vram <= 0;
}

export function capOf(p) {
    const cap = num(p?.specs?.load?.concurrency_cap);
    if (cap !== null && cap > 0) return cap;
    return isCpuOnly(p) ? CPU_CONCURRENCY_CAP : DEFAULT_CONCURRENCY_CAP;
}

/** Most jobs (running + queued) a provider is given before routing skips it. */
export function queueLimitOf(p) {
    return Math.max(capOf(p), QUEUE_LIMIT);
}

/** Jobs on the provider now: max(heartbeat active_jobs, live in-flight we know of). */
export function activeOf(p, inflight = {}) {
    const hb = num(p?.specs?.load?.active_jobs) ?? 0;
    const live = num(inflight?.[p?.id]) ?? 0;
    return Math.max(0, hb, live);
}

export function utilizationOf(p, inflight = {}) {
    return activeOf(p, inflight) / capOf(p);
}

function gpuPegged(p) {
    const gpu = num(p?.specs?.load?.gpu_utilization_max);
    return gpu !== null && gpu >= HIGH_GPU_UTILIZATION_PCT;
}

/** Every slot busy: a new job would wait. */
export function isOverloaded(p, inflight = {}) {
    return activeOf(p, inflight) >= capOf(p) || gpuPegged(p);
}

/** Queue full (or GPU pegged): routing must not add more work here. */
export function isSaturated(p, inflight = {}) {
    return activeOf(p, inflight) >= queueLimitOf(p) || gpuPegged(p);
}

/** Measured tokens/second, or null when the provider has no completed-job history. */
export function capabilityOf(p) {
    const tps = num(p?.specs?.bench?.tokens_per_second_avg);
    return tps !== null && tps > 0 ? tps : null;
}

function median(values) {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The speed an unmeasured provider is assumed to have, given the candidates. */
export function assumedSpeed(candidates) {
    const m = median((candidates ?? []).map(capabilityOf).filter((v) => v !== null));
    return m === null ? UNMEASURED_SPEED_DEFAULT : m * UNMEASURED_SPEED_RATIO;
}

/** Higher = expected to finish a new job sooner: speed / (jobs ahead + 1). */
export function finishScore(p, inflight = {}, unmeasuredSpeed = UNMEASURED_SPEED_DEFAULT) {
    const speed = capabilityOf(p) ?? unmeasuredSpeed;
    return speed / (activeOf(p, inflight) + 1);
}

function reputationOf(p) {
    const r = num(p?.reputation);
    return r === null ? 50 : r;
}

/**
 * Order candidates best first. `inflight` maps provider id -> live
 * assigned/running job count. Returns a new array.
 */
export function rankProviders(candidates, inflight = {}, rng = Math.random) {
    const list = (candidates ?? []).filter(Boolean);
    const unmeasured = assumedSpeed(list);
    const keyed = list.map((p) => ({
        p,
        // 0 = a slot is free, 1 = would queue, 2 = queue full.
        group: isSaturated(p, inflight) ? 2 : isOverloaded(p, inflight) ? 1 : 0,
        lowRep: reputationOf(p) < LOW_REPUTATION,
        score: finishScore(p, inflight, unmeasured),
        rep: reputationOf(p),
        jitter: rng()
    }));
    keyed.sort((a, b) =>
        (a.group - b.group)
        || (a.lowRep - b.lowRep)
        || (b.score - a.score)
        || (b.rep - a.rep)
        || (a.jitter - b.jitter)
    );
    return keyed.map((k) => k.p);
}

/** The provider a new job should go to, or null when there are none. */
export function smartPick(candidates, inflight = {}, rng = Math.random) {
    const ranked = rankProviders(candidates, inflight, rng);
    return ranked[0] ?? null;
}

/** Count live jobs per provider from rows of { provider_id }. */
export function countInflight(rows) {
    const out = {};
    for (const r of rows ?? []) {
        if (!r?.provider_id) continue;
        out[r.provider_id] = (out[r.provider_id] ?? 0) + 1;
    }
    return out;
}

/**
 * Should a chat job that has produced no event yet move to another provider?
 * Pure; the caller (lib/data/chat-rebalance.js) supplies the rows.
 *
 * Moving is only safe when the job has certainly NOT started, because the
 * daemon never marks a job running: it stays 'assigned' until completion. A
 * daemon takes its assigned jobs oldest first, up to its concurrency cap, so
 * a job with at least `cap` older jobs still assigned to the same provider is
 * queued behind them. A provider that stopped heartbeating is not running it
 * either. Anything else (alone on its node, no tokens yet) may be loading the
 * model or reading a long prompt, and is left alone.
 *
 * @param {object} p
 * @param {object} p.job        { status, provider_id, assigned_at, created_at, reservation_id, client_pubkey, input_spec }
 * @param {number} p.events     job_events rows for the job
 * @param {object|null} p.provider  the assigned provider row (null when gone)
 * @param {number} p.olderAssigned  other jobs on that provider, assigned and created before this one
 * @param {number} p.now
 * @param {number} [p.minWaitMs]
 * @param {number} [p.liveWindowMs]
 * @returns {{ move: boolean, reason: string }}
 */
export function rebalanceDecision({ job, events, provider, olderAssigned, now, minWaitMs = 75_000, liveWindowMs = 120_000 }) {
    if (!job || job.status !== "assigned" || !job.provider_id) return { move: false, reason: "not_assigned" };
    if (job.reservation_id) return { move: false, reason: "pinned" };
    // E2E payloads are encrypted to the assigned node's key: nobody else can read them.
    if (job.client_pubkey || job.input_spec?.encrypted_messages) return { move: false, reason: "e2e" };
    if (job.input_spec?.distributed || job.input_spec?.fallback) return { move: false, reason: "not_p2p" };
    if (events > 0) return { move: false, reason: "started" };
    const since = Date.parse(job.assigned_at ?? job.created_at ?? "");
    if (!Number.isFinite(since) || now - since < minWaitMs) return { move: false, reason: "too_soon" };

    const lastSeen = Date.parse(provider?.last_seen ?? "");
    const gone = !provider
        || provider.status !== "available"
        || provider.disabled_at
        || !Number.isFinite(lastSeen)
        || now - lastSeen > liveWindowMs;
    if (gone) return { move: true, reason: "provider_gone" };
    if (olderAssigned >= capOf(provider)) return { move: true, reason: "queued" };
    return { move: false, reason: "may_be_running" };
}
