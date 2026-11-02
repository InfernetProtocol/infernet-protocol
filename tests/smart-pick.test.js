import { describe, expect, it } from "vitest";
import { smartPick, rankProviders, isOverloaded, activeOf, capabilityTier, countInflight } from "../apps/web/lib/routing/smart-pick.js";

const node = (id, { tps, active, cap = 4, gpu, rep = 50 } = {}) => ({
    id, reputation: rep,
    specs: {
        bench: tps === undefined ? undefined : { tokens_per_second_avg: tps },
        load: { active_jobs: active ?? 0, concurrency_cap: cap, ...(gpu === undefined ? {} : { gpu_utilization_max: gpu }) }
    }
});
const fixed = () => 0.5;

describe("smartPick", () => {
    it("picks the most capable provider, not a random weighted one", () => {
        const pick = smartPick([node("cpu", { tps: 8 }), node("gpu", { tps: 90 }), node("mid", { tps: 40 })], {}, fixed);
        expect(pick.id).toBe("gpu");
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

    it("treats a pegged GPU as overloaded", () => {
        expect(isOverloaded(node("g", { tps: 90, gpu: 97 }))).toBe(true);
    });

    it("spreads load between near-equal nodes: least utilized wins", () => {
        const pick = smartPick([node("a", { tps: 90, active: 2 }), node("b", { tps: 82, active: 0 })], {}, fixed);
        expect(pick.id).toBe("b");
    });

    it("a clearly faster node still wins even when a bit busier", () => {
        const pick = smartPick([node("fast", { tps: 90, active: 2 }), node("slow", { tps: 20, active: 0 })], {}, fixed);
        expect(pick.id).toBe("fast");
    });

    it("unmeasured providers rank below measured ones but still get work alone", () => {
        expect(smartPick([node("new"), node("known", { tps: 5 })], {}, fixed).id).toBe("known");
        expect(smartPick([node("new")], {}, fixed).id).toBe("new");
    });

    it("low reputation demotes within a tier", () => {
        const pick = smartPick([node("shady", { tps: 90, rep: 5 }), node("ok", { tps: 85, rep: 60, active: 1 })], {}, fixed);
        expect(pick.id).toBe("ok");
    });

    it("when everyone is overloaded, the least loaded ranks first", () => {
        const ranked = rankProviders([node("a", { tps: 90, active: 8 }), node("b", { tps: 10, active: 4 })], {}, fixed);
        expect(ranked[0].id).toBe("b");
    });

    it("exact ties are broken by rng so equal nodes share traffic", () => {
        const nodes = [node("a", { tps: 50 }), node("b", { tps: 50 })];
        const seq = [0.9, 0.1];
        let i = 0;
        expect(smartPick(nodes, {}, () => seq[i++ % 2]).id).toBe("b");
    });

    it("returns null on no candidates", () => {
        expect(smartPick([], {})).toBe(null);
    });
});

describe("helpers", () => {
    it("capabilityTier buckets relative to the best", () => {
        expect(capabilityTier(node("x", { tps: 85 }), 90)).toBe(0);
        expect(capabilityTier(node("y", { tps: 20 }), 90)).toBeGreaterThan(0);
    });
    it("countInflight counts per provider and skips nulls", () => {
        expect(countInflight([{ provider_id: "a" }, { provider_id: "a" }, { provider_id: null }, { provider_id: "b" }])).toEqual({ a: 2, b: 1 });
    });
});
