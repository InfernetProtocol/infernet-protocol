import { describe, expect, it } from "vitest";
import {
    slotsForVram, parseOllamaNumParallel, ollamaNumParallel, resolveMaxConcurrentJobs, totalVramGbOf
} from "../apps/cli/lib/concurrency.js";

// Anthony, 2026-11-18: "a node should be able to handle parallel jobs if
// capacity exists, make that the default".
describe("daemon concurrency: capacity-based by default", () => {
    it("CPU-only nodes run one job at a time", () => {
        expect(resolveMaxConcurrentJobs({ env: {}, totalVramGb: 0 })).toEqual({ value: 1, source: "cpu-only node" });
        expect(resolveMaxConcurrentJobs({ env: {}, totalVramGb: null }).value).toBe(1);
        // Even if Ollama has more slots: CPU requests share the same cores.
        expect(resolveMaxConcurrentJobs({ env: {}, totalVramGb: 0, runtimeSlots: 4 }).value).toBe(1);
    });

    it("GPU nodes follow Ollama's parallel slots when known", () => {
        expect(resolveMaxConcurrentJobs({ env: {}, totalVramGb: 12, runtimeSlots: 3 })).toEqual({ value: 3, source: "OLLAMA_NUM_PARALLEL" });
    });

    it("else size from VRAM, the same table install.sh uses", () => {
        expect(slotsForVram(8)).toBe(1);
        expect(slotsForVram(12)).toBe(2);   // RTX 3060 12 GB
        expect(slotsForVram(24)).toBe(3);
        expect(slotsForVram(48)).toBe(4);
        expect(slotsForVram(160)).toBe(4);
        expect(resolveMaxConcurrentJobs({ env: {}, totalVramGb: 12 }).value).toBe(2);
    });

    it("operator override: env beats config beats capacity", () => {
        expect(resolveMaxConcurrentJobs({ env: { INFERNET_MAX_CONCURRENT_JOBS: "1" }, totalVramGb: 48, runtimeSlots: 4 }).value).toBe(1);
        expect(resolveMaxConcurrentJobs({ env: { INFERNET_MAX_CONCURRENT_JOBS: "3" }, totalVramGb: 0 }).value).toBe(3);
        expect(resolveMaxConcurrentJobs({ env: {}, config: { engine: { max_concurrent_jobs: 2 } }, totalVramGb: 0 }).value).toBe(2);
        expect(resolveMaxConcurrentJobs({ env: { INFERNET_MAX_CONCURRENT_JOBS: "junk" }, totalVramGb: 12 }).value).toBe(2);
    });

    it("reads OLLAMA_NUM_PARALLEL from ollama.service, then the process env", async () => {
        expect(parseOllamaNumParallel('"PATH=/usr/bin" OLLAMA_FLASH_ATTENTION=1 OLLAMA_NUM_PARALLEL=2')).toBe(2);
        expect(parseOllamaNumParallel("OLLAMA_HOST=0.0.0.0")).toBeNull();
        expect(parseOllamaNumParallel(null)).toBeNull();
        expect(await ollamaNumParallel({ env: {}, run: async () => "OLLAMA_NUM_PARALLEL=3" })).toBe(3);
        expect(await ollamaNumParallel({ env: { OLLAMA_NUM_PARALLEL: "2" }, run: async () => null })).toBe(2);
        expect(await ollamaNumParallel({ env: {}, run: async () => { throw new Error("no systemd"); } })).toBeNull();
    });

    it("sums VRAM across GPUs", () => {
        expect(totalVramGbOf([{ vram_mb: 12288 }, { vram_mb: 12288 }])).toBe(24);
        expect(totalVramGbOf([])).toBe(0);
        expect(totalVramGbOf(null)).toBe(0);
    });
});
