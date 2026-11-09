import { describe, expect, it } from "vitest";
import {
    smartPick, rankProviders, isOverloaded, isSaturated, activeOf, capOf, queueLimitOf,
    assumedSpeed, finishScore, countInflight, rebalanceDecision,
    DEFAULT_CONCURRENCY_CAP, CPU_CONCURRENCY_CAP
} from "../apps/web/lib/routing/smart-pick.js";

// A GPU node unless `cpu` is set; cap is only advertised when given.
const node = (id, { tps, active, cap, gpu, rep = 50, cpu = false } = {}) => ({
    id, reputation: rep,
    specs: {
        bench: tps === undefined ? undefined : { tokens_per_second_avg: tps },
        load: {
            active_jobs: active ?? 0,
            ...(cap === undefined ? {} : { concurrency_cap: cap }),
            vram: { total_gb: cpu ? 0 : 24 },
            ...(gpu === undefined ? {} : { gpu_utilization_max: gpu })
        }
    }
});
const cpuNode = (id, opts = {}) => node(id, { ...opts, cpu: true });
const fixed = () => 0.5;

describe("smartPick: expected finish time", () => {
    it("a free 2.6 tok/s node beats a 5.2 tok/s node with a job in flight", () => {
        // The 2026-11-09 fleet: bonita 5.21, dev2 2.64, all CPU-only.
        const bonita = cpuNode("bonita", { tps: 5.21 });
        const dev2 = cpuNode("dev2", { tps: 2.64 });
        expect(smartPick([bonita, dev2], { bonita: 1 }, fixed).id).toBe("dev2");
        // Same even with GPU-style caps where bonita still has free slots:
        // 5.21 / 2 < 2.64 / 1.
        const g1 = node("bonita", { tps: 5.21 });
        const g2 = node("dev2", { tps: 2.64 });
        expect(smartPick([g1, g2], { bonita: 1 }, fixed).id).toBe("dev2");
    });

    it("when every node is free, the fastest wins", () => {
        const pick = smartPick([cpuNode("a", { tps: 1.14 }), cpuNode("b", { tps: 5.21 }), cpuNode("c", { tps: 2.64 })], {}, fixed);
        expect(pick.id).toBe("b");
    });

    it("equal nodes share traffic: a burst spreads instead of piling on one", () => {
        const nodes = [cpuNode("a", { tps: 3 }), cpuNode("b", { tps: 3 }), cpuNode("c", { tps: 3 })];
        const inflight = {};
        const seen = new Set();
        let seed = 1;
        const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
        for (let i = 0; i < 3; i++) {
            const p = smartPick(nodes, inflight, rng);
            inflight[p.id] = (inflight[p.id] ?? 0) + 1;
            seen.add(p.id);
        }
        expect([...seen].sort()).toEqual(["a", "b", "c"]);
    });

    it("exact ties are broken by rng", () => {
        const nodes = [node("a", { tps: 50 }), node("b", { tps: 50 })];
        const seq = [0.9, 0.1];
        let i = 0;
        expect(smartPick(nodes, {}, () => seq[i++ % 2]).id).toBe("b");
    });

    it("a burst on the 2026-11-09 fleet no longer piles onto the fastest node", () => {
        const fleet = [
            cpuNode("bonita", { tps: 5.21 }), cpuNode("dev2", { tps: 2.64 }),
            cpuNode("vienna", { tps: 1.14 }), cpuNode("dev3")
        ];
        const inflight = {};
        for (let i = 0; i < 4; i++) {
            const p = smartPick(fleet, inflight, fixed);
            inflight[p.id] = (inflight[p.id] ?? 0) + 1;
        }
        expect(inflight).toEqual({ bonita: 1, dev2: 1, vienna: 1, dev3: 1 });
    });

    it("skips an overloaded fast node for a free slower one", () => {
        const pick = smartPick([node("gpu", { tps: 90, active: 4 }), node("mid", { tps: 40 })], {}, fixed);
        expect(pick.id).toBe("mid");
    });

    it("counts live in-flight jobs when the heartbeat lags a burst", () => {
        const nodes = [node("gpu", { tps: 90, active: 0 }), node("mid", { tps: 40 })];
        expect(smartPick(nodes, { gpu: 4 }, fixed).id).toBe("mid");
        expect(activeOf(nodes[0], { gpu: 4 })).toBe(4);
    });

    it("a clearly faster GPU node still wins when it has free slots", () => {
        const pick = smartPick([node("fast", { tps: 90, active: 2 }), node("slow", { tps: 20, active: 0 })], {}, fixed);
        expect(pick.id).toBe("fast");
    });

    it("unmeasured nodes are assumed 3/4 of the median: they lose to a free fast node, win over a busy one", () => {
        const known = node("known", { tps: 5 });
        expect(smartPick([node("new"), known], {}, fixed).id).toBe("known");
        expect(smartPick([node("new"), known], { known: 1 }, fixed).id).toBe("new");
        expect(smartPick([node("new")], {}, fixed).id).toBe("new");
    });

    it("low reputation demotes within a load group", () => {
        const pick = smartPick([node("shady", { tps: 90, rep: 5 }), node("ok", { tps: 85, rep: 60, active: 1 })], {}, fixed);
        expect(pick.id).toBe("ok");
    });

    it("when everyone is busy, the job queues where it is expected to finish first", () => {
        const ranked = rankProviders([cpuNode("slow", { tps: 0.32, active: 1 }), cpuNode("fast", { tps: 5.21, active: 2 })], {}, fixed);
        expect(ranked[0].id).toBe("fast");
    });

    it("a node with a full queue ranks after one that can still queue", () => {
        const ranked = rankProviders([node("full", { tps: 90, active: 4 }), cpuNode("busy", { tps: 1, active: 1 })], {}, fixed);
        expect(ranked.map((p) => p.id)).toEqual(["busy", "full"]);
    });

    it("returns null on no candidates", () => {
        expect(smartPick([], {})).toBe(null);
    });
});

describe("concurrency caps", () => {
    it("a CPU-only node that advertises nothing runs one job at a time", () => {
        expect(capOf(cpuNode("c"))).toBe(CPU_CONCURRENCY_CAP);
        expect(isOverloaded(cpuNode("c", { active: 1 }))).toBe(true);
        expect(isOverloaded(cpuNode("c", { active: 0 }))).toBe(false);
    });

    it("a GPU node, or one with no load info, keeps the default of 4", () => {
        expect(capOf(node("g"))).toBe(DEFAULT_CONCURRENCY_CAP);
        expect(capOf({ id: "x", specs: {} })).toBe(DEFAULT_CONCURRENCY_CAP);
        expect(isOverloaded(node("g", { active: 3 }))).toBe(false);
    });

    it("an advertised cap wins either way", () => {
        expect(capOf(cpuNode("c", { cap: 2 }))).toBe(2);
        expect(capOf(node("g", { cap: 1 }))).toBe(1);
    });

    it("queue limit is max(cap, 4): CPU nodes still queue a burst instead of failing it", () => {
        expect(queueLimitOf(cpuNode("c"))).toBe(4);
        expect(queueLimitOf(node("g", { cap: 8 }))).toBe(8);
        expect(isSaturated(cpuNode("c", { active: 3 }))).toBe(false);
        expect(isSaturated(cpuNode("c", { active: 4 }))).toBe(true);
    });

    it("treats a pegged GPU as overloaded and saturated", () => {
        expect(isOverloaded(node("g", { tps: 90, gpu: 97 }))).toBe(true);
        expect(isSaturated(node("g", { tps: 90, gpu: 97 }))).toBe(true);
    });
});

describe("helpers", () => {
    it("assumedSpeed is 3/4 of the median measured speed, 1 with none", () => {
        expect(assumedSpeed([node("a", { tps: 2 }), node("b", { tps: 4 }), node("c")])).toBeCloseTo(2.25);
        expect(assumedSpeed([node("a")])).toBe(1);
    });
    it("finishScore divides speed by the jobs ahead plus one", () => {
        expect(finishScore(node("a", { tps: 6, active: 2 }))).toBe(2);
    });
    it("countInflight counts per provider and skips nulls", () => {
        expect(countInflight([{ provider_id: "a" }, { provider_id: "a" }, { provider_id: null }, { provider_id: "b" }])).toEqual({ a: 2, b: 1 });
    });
});

describe("rebalanceDecision", () => {
    const now = Date.parse("2026-11-09T08:00:00Z");
    const ago = (s) => new Date(now - s * 1000).toISOString();
    const job = (over = {}) => ({ status: "assigned", provider_id: "p", assigned_at: ago(90), created_at: ago(90), input_spec: {}, ...over });
    const live = (over = {}) => ({ ...cpuNode("p"), status: "available", last_seen: ago(20), ...over });
    const decide = (over = {}) => rebalanceDecision({ job: job(), events: 0, provider: live(), olderAssigned: 1, now, ...over });

    it("moves a job queued behind the node's running job", () => {
        expect(decide()).toEqual({ move: true, reason: "queued" });
    });

    it("leaves a job that is alone on its node: it may be loading the model", () => {
        expect(decide({ olderAssigned: 0 })).toEqual({ move: false, reason: "may_be_running" });
    });

    it("leaves a job that has produced any event", () => {
        expect(decide({ events: 1 }).move).toBe(false);
    });

    it("waits 75 s before considering a move", () => {
        expect(decide({ job: job({ assigned_at: ago(30) }) }).reason).toBe("too_soon");
    });

    it("respects the node's cap: a 4-slot GPU node runs 3 older jobs and this one", () => {
        expect(decide({ provider: live({ specs: { load: { vram: { total_gb: 24 } } } }), olderAssigned: 3 }).move).toBe(false);
        expect(decide({ provider: live({ specs: { load: { vram: { total_gb: 24 } } } }), olderAssigned: 4 }).move).toBe(true);
    });

    it("moves a job whose node went silent or away", () => {
        expect(decide({ olderAssigned: 0, provider: live({ last_seen: ago(300) }) })).toEqual({ move: true, reason: "provider_gone" });
        expect(decide({ olderAssigned: 0, provider: null }).move).toBe(true);
    });

    it("never moves pinned, E2E, fallback or finished jobs", () => {
        expect(decide({ job: job({ reservation_id: "r" }) }).move).toBe(false);
        expect(decide({ job: job({ client_pubkey: "a".repeat(64) }) }).move).toBe(false);
        expect(decide({ job: job({ input_spec: { fallback: "nvidia-nim" } }) }).move).toBe(false);
        expect(decide({ job: job({ status: "completed" }) }).move).toBe(false);
    });
});
