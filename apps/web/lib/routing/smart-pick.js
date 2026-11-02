/**
 * Smart routing: send a chat job to the most capable provider that is not
 * overloaded. Pure (no DB), so it is unit-tested directly.
 *
 *   1. Overloaded providers are skipped while anyone else can take the job.
 *      Load is the larger of the heartbeat's active_jobs and the live count
 *      of assigned/running jobs we routed there (heartbeats lag a burst).
 *      Overloaded = load >= concurrency cap, or GPU pegged >= 95%.
 *      If everyone is overloaded, the least loaded is used.
 *   2. Capability = measured tokens/second from completed jobs
 *      (specs.bench.tokens_per_second_avg). Providers within ~15% of the
 *      best are one tier, so a marginally faster node does not take every
 *      job. Unmeasured providers rank below measured ones but still get
 *      work when nothing better is free.
 *   3. Within the top tier: lowest utilization (load / cap), then higher
 *      reputation; exact ties are broken at random so equal nodes share
 *      the traffic.
 *
 * Reputation below LOW_REPUTATION demotes a provider to the bottom of its
 * tier instead of excluding it outright.
 */

export const DEFAULT_CONCURRENCY_CAP = 4;
export const HIGH_GPU_UTILIZATION_PCT = 95;
const CAPABILITY_TIER_RATIO = 1.15;
const LOW_REPUTATION = 20;

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

export function capOf(p) {
    const cap = num(p?.specs?.load?.concurrency_cap);
    return cap !== null && cap > 0 ? cap : DEFAULT_CONCURRENCY_CAP;
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

export function isOverloaded(p, inflight = {}) {
    if (activeOf(p, inflight) >= capOf(p)) return true;
    const gpu = num(p?.specs?.load?.gpu_utilization_max);
    return gpu !== null && gpu >= HIGH_GPU_UTILIZATION_PCT;
}

/** Measured tokens/second, or null when the provider has no completed-job history. */
export function capabilityOf(p) {
    const tps = num(p?.specs?.bench?.tokens_per_second_avg);
    return tps !== null && tps > 0 ? tps : null;
}

/** 0 = within ~15% of the best measured provider, 1 = next step down, ...; unmeasured last. */
export function capabilityTier(p, best) {
    const tps = capabilityOf(p);
    if (tps === null || !(best > 0)) return Number.MAX_SAFE_INTEGER;
    return Math.floor(Math.log(Math.max(1, best / tps)) / Math.log(CAPABILITY_TIER_RATIO));
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
    const best = Math.max(0, ...list.map((p) => capabilityOf(p) ?? 0));
    const keyed = list.map((p) => ({
        p,
        overloaded: isOverloaded(p, inflight),
        tier: capabilityTier(p, best),
        lowRep: reputationOf(p) < LOW_REPUTATION,
        util: utilizationOf(p, inflight),
        rep: reputationOf(p),
        jitter: rng()
    }));
    keyed.sort((a, b) =>
        (a.overloaded - b.overloaded)
        || (a.overloaded && b.overloaded ? a.util - b.util : 0)
        || (a.tier - b.tier)
        || (a.lowRep - b.lowRep)
        || (a.util - b.util)
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
