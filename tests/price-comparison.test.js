import { describe, expect, it } from "vitest";
import { comparisonRows, jobCostUsd, formatUsd, EXAMPLE_JOB, REFERENCE_PRICES } from "../apps/web/lib/pricing/comparison.js";

const pricing = {
    enabled: true,
    models: {
        "qwen2.5:0.5b": { input_per_m_usd: 0.01, output_per_m_usd: 0.04 },
        "qwen2.5:7b": { input_per_m_usd: 0.05, output_per_m_usd: 0.2 },
        "qwen2.5:1.5b": { input_per_m_usd: 0.02, output_per_m_usd: 0.08 }
    }
};

describe("price comparison", () => {
    it("prices the example job: 10M in + 2M out", () => {
        expect(EXAMPLE_JOB.input_tokens).toBe(10_000_000);
        expect(EXAMPLE_JOB.output_tokens).toBe(2_000_000);
        expect(jobCostUsd({ input_per_m_usd: 0.05, output_per_m_usd: 0.2 })).toBeCloseTo(0.9, 10);
        expect(jobCostUsd({ input_per_m_usd: 4, output_per_m_usd: 20 })).toBe(80);
        expect(jobCostUsd({ input_per_m_usd: 10, output_per_m_usd: 50 })).toBe(200);
    });

    it("lists our models largest first, then the dated references with sources", () => {
        const rows = comparisonRows(pricing);
        expect(rows.map((r) => r.id)).toEqual(["qwen2.5:7b", "qwen2.5:1.5b", "qwen2.5:0.5b", "claude-opus-5-5", "gpt-6-astra"]);
        for (const r of rows.filter((x) => !x.ours)) {
            expect(r.source).toMatch(/^https:\/\//);
            expect(r.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    it("never advertises our prices when paid batch is switched off", () => {
        const rows = comparisonRows({ ...pricing, enabled: false });
        expect(rows.every((r) => !r.ours)).toBe(true);
        expect(rows).toHaveLength(REFERENCE_PRICES.length);
    });

    it("reference prices match the official pages checked 2026-11-02", () => {
        const byId = Object.fromEntries(REFERENCE_PRICES.map((r) => [r.id, r]));
        expect(byId["claude-opus-5-5"]).toMatchObject({ input_per_m_usd: 4, output_per_m_usd: 20 });
        expect(byId["gpt-6-astra"]).toMatchObject({ input_per_m_usd: 10, output_per_m_usd: 50 });
    });

    it("formats small and large amounts honestly", () => {
        expect(formatUsd(0.9)).toBe("$0.90");
        expect(formatUsd(0.36)).toBe("$0.36");
        expect(formatUsd(80)).toBe("$80");
        expect(formatUsd(200)).toBe("$200");
        expect(formatUsd(0.0042)).toBe("$0.0042");
        expect(formatUsd(1.5)).toBe("$1.50");
    });
});
