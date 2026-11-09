import { describe, expect, it } from "vitest";
import { filterFittingModels } from "../apps/cli/commands/register.js";

// Don't import server-only modules in vitest's node env. Re-export
// reputationWeightedPick from the same file.
import { reputationWeightedPick, headroomScore, notSaturated, meetsTrustTier, finishPick, e2EChatModelNames, withLocalPicks } from "../apps/web/lib/data/chat.js";

const GB = 1024 ** 3;
const PUBKEY = "a".repeat(64);

function e2eProvider(id, specs = {}) {
    return {
        id,
        public_key: PUBKEY,
        reputation: 50,
        trust_tier: "public",
        specs: {
            e2e_capable: true,
            e2e_version: "nip44-v2",
            served_models: ["qwen2.5:7b"],
            model_keys: { "qwen2.5:7b": "b".repeat(64) },
            ...specs
        }
    };
}

describe("E2E chat model availability", () => {
    it("lists only a model that a live, unsaturated E2E provider can take", () => {
        const saturated = e2eProvider("busy", { load: { active_jobs: 4, concurrency_cap: 4 } });
        const ready = e2eProvider("ready");
        const plaintext = { ...e2eProvider("plaintext"), specs: { served_models: ["qwen2.5:7b"] } };
        const missingModelKey = e2eProvider("no-model-key", { model_keys: {} });

        expect(e2EChatModelNames([saturated, ready, plaintext, missingModelKey])).toEqual(["qwen2.5:7b"]);
        expect(e2EChatModelNames([saturated])).toEqual([]);
    });

    it("can exclude a slow provider and pick another E2E node for the same model", () => {
        const slow = e2eProvider("slow");
        const backup = e2eProvider("backup");
        expect(finishPick([slow, backup], {
            modelName: "qwen2.5:7b",
            requireE2E: true,
            excludeProviderIds: ["slow"]
        })).toBe(backup);
        expect(finishPick([slow], {
            modelName: "qwen2.5:7b",
            requireE2E: true,
            excludeProviderIds: ["slow"]
        })).toBeNull();
    });
});

describe("filterFittingModels", () => {
    it("accepts every model on a generous GPU box", () => {
        const result = filterFittingModels(
            [
                { name: "qwen2.5:0.5b", size_bytes: 0.4 * GB },
                { name: "qwen2.5:7b", size_bytes: 4.4 * GB },
                { name: "llama3:70b", size_bytes: 40 * GB }
            ],
            { totalVramBytes: 80 * GB, totalRamBytes: 256 * GB }
        );
        expect(result.fitting).toEqual(["qwen2.5:0.5b", "qwen2.5:7b", "llama3:70b"]);
        expect(result.rejected).toEqual([]);
        expect(result.mode).toBe("gpu");
    });

    it("rejects models that don't fit on a tight CPU-only box", () => {
        const result = filterFittingModels(
            [
                { name: "qwen2.5:0.5b", size_bytes: 0.4 * GB },
                { name: "qwen2.5:7b", size_bytes: 4.4 * GB },
                { name: "qwen3.5:9b", size_bytes: 5.5 * GB }
            ],
            { totalVramBytes: 0, totalRamBytes: 6 * GB } // 6 GB RAM × 0.6 = 3.6 GB ceiling
        );
        expect(result.fitting).toEqual(["qwen2.5:0.5b"]);
        expect(result.rejected).toHaveLength(2);
        expect(result.rejected.map((r) => r.name)).toEqual(["qwen2.5:7b", "qwen3.5:9b"]);
        expect(result.mode).toBe("cpu");
    });

    it("rejects an oversized model on a small GPU", () => {
        const result = filterFittingModels(
            [
                { name: "qwen2.5:7b", size_bytes: 4.4 * GB },
                { name: "llama3:70b", size_bytes: 40 * GB }
            ],
            { totalVramBytes: 8 * GB, totalRamBytes: 32 * GB } // 8 × 0.85 = 6.8 GB ceiling
        );
        expect(result.fitting).toEqual(["qwen2.5:7b"]);
        expect(result.rejected.map((r) => r.name)).toEqual(["llama3:70b"]);
    });

    it("passes through models with unknown size (Ollama didn't report)", () => {
        const result = filterFittingModels(
            [{ name: "mystery:7b", size_bytes: null }],
            { totalVramBytes: 0, totalRamBytes: 1 * GB }
        );
        expect(result.fitting).toEqual(["mystery:7b"]);
        expect(result.rejected).toEqual([]);
    });

    it("multi-GPU sums VRAM (tensor parallelism)", () => {
        const result = filterFittingModels(
            [{ name: "llama3:70b", size_bytes: 40 * GB }],
            { totalVramBytes: 24 * GB + 24 * GB, totalRamBytes: 32 * GB } // 48 × 0.85 = 40.8
        );
        expect(result.fitting).toEqual(["llama3:70b"]);
    });
});

describe("notSaturated", () => {
    it("passes a node with no load info (don't penalize unknowns)", () => {
        expect(notSaturated({ specs: {} })).toBe(true);
        expect(notSaturated({})).toBe(true);
    });

    it("rejects a node at or above its concurrency cap", () => {
        expect(notSaturated({ specs: { load: { active_jobs: 4, concurrency_cap: 4 } } })).toBe(false);
        expect(notSaturated({ specs: { load: { active_jobs: 5, concurrency_cap: 4 } } })).toBe(false);
        expect(notSaturated({ specs: { load: { active_jobs: 3, concurrency_cap: 4 } } })).toBe(true);
    });

    it("rejects a node with GPU pegged ≥ 95% even if active_jobs is low", () => {
        expect(notSaturated({ specs: { load: { active_jobs: 0, gpu_utilization_max: 99 } } })).toBe(false);
        expect(notSaturated({ specs: { load: { active_jobs: 0, gpu_utilization_max: 90 } } })).toBe(true);
    });

    it("uses default cap of 4 when not advertised", () => {
        expect(notSaturated({ specs: { load: { active_jobs: 4 } } })).toBe(false);
        expect(notSaturated({ specs: { load: { active_jobs: 3 } } })).toBe(true);
    });
});

describe("headroomScore", () => {
    it("returns 1 when no load info — don't penalize", () => {
        expect(headroomScore({})).toBe(1);
        expect(headroomScore({ specs: {} })).toBe(1);
    });

    it("sums free RAM + free VRAM + slot bonus", () => {
        const score = headroomScore({
            specs: { load: { active_jobs: 0, concurrency_cap: 4, ram: { free_gb: 32 }, vram: { free_gb: 24 } } }
        });
        // 32 + 24 + 4×(1-0/4) = 60
        expect(score).toBe(60);
    });

    it("slot bonus shrinks as active_jobs approaches cap", () => {
        const half = headroomScore({
            specs: { load: { active_jobs: 2, concurrency_cap: 4, ram: { free_gb: 0 }, vram: { free_gb: 0 } } }
        });
        // 0 + 0 + 4×(1-2/4) = 2 → max(1, 2) = 2
        expect(half).toBe(2);
    });

    it("floors at 1 (a still-eligible saturated node gets minimal weight, not zero)", () => {
        const fullyBusy = headroomScore({
            specs: { load: { active_jobs: 4, concurrency_cap: 4, ram: { free_gb: 0 }, vram: { free_gb: 0 } } }
        });
        expect(fullyBusy).toBe(1);
    });
});

describe("reputationWeightedPick", () => {
    it("returns null on empty input", () => {
        expect(reputationWeightedPick([])).toBeNull();
        expect(reputationWeightedPick(null)).toBeNull();
    });

    it("returns the only candidate without rolling RNG", () => {
        let called = false;
        const result = reputationWeightedPick([{ id: "a", reputation: 50 }], () => {
            called = true;
            return 0.5;
        });
        expect(result.id).toBe("a");
        expect(called).toBe(false);
    });

    it("higher reputation wins more often (reputation 99 vs 1)", () => {
        const candidates = [
            { id: "high", reputation: 99 },
            { id: "low", reputation: 1 }
        ];
        let highWins = 0;
        const N = 1000;
        let seed = 0;
        // Deterministic LCG so the test isn't flaky.
        const rng = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 0x100000000;
        };
        for (let i = 0; i < N; i++) {
            if (reputationWeightedPick(candidates, rng).id === "high") highWins += 1;
        }
        // Expected ~99% wins for high — give a 5% tolerance.
        expect(highWins / N).toBeGreaterThan(0.94);
        expect(highWins / N).toBeLessThan(1);
    });

    it("zero-reputation provider still has a non-zero chance (floor at 1)", () => {
        // With reputations {0, 50}, weights become {1×10, 50×10} = {10, 500}
        // (floor + default-tps=10). Total=510 → fresh wins iff rng()<10/510≈0.0196.
        const candidates = [
            { id: "fresh", reputation: 0 },
            { id: "veteran", reputation: 50 }
        ];
        expect(reputationWeightedPick(candidates, () => 0.01).id).toBe("fresh");
        expect(reputationWeightedPick(candidates, () => 0.5).id).toBe("veteran");
    });

    it("faster node (higher tokens_per_second_avg) wins more often at equal reputation", () => {
        const candidates = [
            { id: "slow", reputation: 50, specs: { bench: { tokens_per_second_avg: 5 } } },
            { id: "fast", reputation: 50, specs: { bench: { tokens_per_second_avg: 100 } } }
        ];
        // Weights: 50×5=250 vs 50×100=5000. Total=5250. Fast wins iff rng()>250/5250≈0.0476.
        expect(reputationWeightedPick(candidates, () => 0.5).id).toBe("fast");
        expect(reputationWeightedPick(candidates, () => 0.04).id).toBe("slow");
        expect(reputationWeightedPick(candidates, () => 0.05).id).toBe("fast");
    });

    it("saturated node loses traffic to a node with headroom (same rep + tps)", () => {
        const saturated = {
            id: "saturated", reputation: 50,
            specs: {
                bench: { tokens_per_second_avg: 50 },
                load: { active_jobs: 4, ram: { free_gb: 0.1 }, vram: { free_gb: 0 }, concurrency_cap: 4 }
            }
        };
        const idle = {
            id: "idle", reputation: 50,
            specs: {
                bench: { tokens_per_second_avg: 50 },
                load: { active_jobs: 0, ram: { free_gb: 32 }, vram: { free_gb: 24 }, concurrency_cap: 4 }
            }
        };
        // Saturated weight: 50×50×max(1, 0.1+0+4×(1-1)) = 50×50×1 = 2500
        // Idle weight:      50×50×(32+24+4)        = 50×50×60 = 150000
        // Idle should win essentially always.
        let idleWins = 0;
        let seed = 7;
        const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
        for (let i = 0; i < 1000; i++) {
            if (reputationWeightedPick([saturated, idle], rng).id === "idle") idleWins += 1;
        }
        expect(idleWins / 1000).toBeGreaterThan(0.95);
    });

    it("missing load.* falls back to headroom=1 (no provider stranded)", () => {
        const candidates = [
            { id: "no-load", reputation: 50, specs: { bench: { tokens_per_second_avg: 10 } } },
            { id: "with-load", reputation: 50, specs: { bench: { tokens_per_second_avg: 10 }, load: { ram: { free_gb: 0 }, vram: { free_gb: 0 } } } }
        ];
        // Both end up with headroom 1+ (with-load: max(1, 0+0+slot=4)=4 vs no-load: 1)
        // Actually: no-load = no load object → headroom 1. with-load has slot_bonus=4 (active=0,cap=4) → 4.
        // Weights: 500 vs 2000. with-load should win ~80%.
        let withLoadWins = 0;
        let seed = 99;
        const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
        for (let i = 0; i < 1000; i++) {
            if (reputationWeightedPick(candidates, rng).id === "with-load") withLoadWins += 1;
        }
        // Bound generous — point is no-load gets tried, just less.
        expect(withLoadWins).toBeGreaterThan(700);
        expect(withLoadWins).toBeLessThan(1000);
    });

    it("missing tokens_per_second_avg falls back to baseline 10 (no provider stranded)", () => {
        const candidates = [
            { id: "no-bench", reputation: 50 },
            { id: "with-bench", reputation: 50, specs: { bench: { tokens_per_second_avg: 10 } } }
        ];
        // Both end up with weight 50×10=500. 50/50 split.
        const N = 1000;
        let firstWins = 0;
        let seed = 1;
        const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
        for (let i = 0; i < N; i++) {
            if (reputationWeightedPick(candidates, rng).id === "no-bench") firstWins += 1;
        }
        expect(firstWins / N).toBeGreaterThan(0.4);
        expect(firstWins / N).toBeLessThan(0.6);
    });
});

describe("meetsTrustTier", () => {
    it("treats absent or 'public' minTier as always satisfied", () => {
        expect(meetsTrustTier({ trust_tier: "public" })).toBe(true);
        expect(meetsTrustTier({ trust_tier: "verified" }, "public")).toBe(true);
        expect(meetsTrustTier({}, undefined)).toBe(true);
    });

    it("respects the rank ladder public < verified < trusted < private", () => {
        expect(meetsTrustTier({ trust_tier: "public" }, "verified")).toBe(false);
        expect(meetsTrustTier({ trust_tier: "verified" }, "verified")).toBe(true);
        expect(meetsTrustTier({ trust_tier: "trusted" }, "verified")).toBe(true);
        expect(meetsTrustTier({ trust_tier: "verified" }, "trusted")).toBe(false);
        expect(meetsTrustTier({ trust_tier: "trusted" }, "trusted")).toBe(true);
    });

    it("defaults missing trust_tier to 'public'", () => {
        expect(meetsTrustTier({}, "verified")).toBe(false);
        expect(meetsTrustTier({}, "public")).toBe(true);
    });
});

describe("finishPick on CPU-only nodes", () => {
    const cpu = (id, tps) => ({ id, reputation: 50, specs: { served_models: ["m"], bench: { tokens_per_second_avg: tps }, load: { active_jobs: 0, vram: { total_gb: 0 } } } });

    it("sends the second job of a burst to the idle slower node", () => {
        expect(finishPick([cpu("fast", 5.2), cpu("slow", 2.6)], { modelName: "m" }, { fast: 1 }).id).toBe("slow");
    });

    it("queues on a busy node rather than failing when every node is busy", () => {
        expect(finishPick([cpu("fast", 5.2)], { modelName: "m" }, { fast: 2 }).id).toBe("fast");
        expect(finishPick([cpu("fast", 5.2)], { modelName: "m" }, { fast: 4 })).toBeNull();
    });

    it("withLocalPicks counts picks the database read cannot have seen", () => {
        const now = 100_000;
        const picks = [
            { providerId: "a", at: now - 1_000, insertedAt: null },          // not inserted yet
            { providerId: "a", at: now - 2_000, insertedAt: now - 500 },     // inserted after the read began
            { providerId: "b", at: now - 3_000, insertedAt: now - 2_900 },   // inserted before: DB has it
            { providerId: "c", at: now - 60_000, insertedAt: null }          // expired
        ];
        expect(withLocalPicks({ b: 1 }, picks, now - 800, now)).toEqual({ a: 2, b: 1 });
    });

    it("a simultaneous burst spreads once local picks are counted", () => {
        const nodes = [cpu("fast", 5.2), cpu("mid", 2.6), cpu("slow", 1.1)];
        const picks = [];
        const got = [];
        for (let i = 0; i < 3; i++) {
            // Every request read the same empty in-flight snapshot from the DB.
            const p = finishPick(nodes, { modelName: "m" }, withLocalPicks({}, picks, 0, 1));
            picks.push({ providerId: p.id, at: 1, insertedAt: null });
            got.push(p.id);
        }
        expect(got).toEqual(["fast", "mid", "slow"]);
    });

    it("requireFreeSlot only returns a node that can start now", () => {
        expect(finishPick([cpu("fast", 5.2)], { modelName: "m", requireFreeSlot: true }, { fast: 1 })).toBeNull();
        expect(finishPick([cpu("fast", 5.2), cpu("slow", 1)], { modelName: "m", requireFreeSlot: true, excludeProviderIds: ["fast"] }, {}).id).toBe("slow");
    });
});
