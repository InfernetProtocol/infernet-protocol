import { describe, expect, it } from "vitest";
import { ABLITERATED_DEFAULT, MODEL_SUGGESTIONS, pickDefaultSuggestion } from "../apps/cli/commands/setup.js";
import { recommendModels } from "../apps/cli/lib/recommender.js";
import { CATALOG } from "../apps/web/lib/model-catalog.js";

const evalFor = (vramGb) => MODEL_SUGGESTIONS.map((m) => ({ ...m, fits: m.size_gb * 1.2 <= vramGb }));

describe("abliterated default for self-hosted nodes", () => {
    it("defaults a 24 GB GPU to the abliterated model", () => {
        expect(pickDefaultSuggestion(evalFor(24), { isCpuOnly: false })).toBe(ABLITERATED_DEFAULT);
    });

    it("opting out picks the largest stock model that fits", () => {
        expect(pickDefaultSuggestion(evalFor(80), { isCpuOnly: false, abliterated: false })).toBe("qwen2.5:72b");
    });

    it("falls back to stock when the abliterated model does not fit", () => {
        expect(pickDefaultSuggestion(evalFor(12), { isCpuOnly: false })).toBe("qwen2.5:14b");
    });

    it("CPU-only hosts keep the smallest model", () => {
        expect(pickDefaultSuggestion(evalFor(0), { isCpuOnly: true })).toBe("qwen2.5:0.5b");
    });

    it("the recommender ranks the abliterated Qwen first for uncensored on 24 GB", () => {
        const [top] = recommendModels({ vramGb: 24, ramGb: 64, uncensoredOnly: true, limit: 1 });
        expect(top.model.id).toBe("qwen3.8-27b-abliterated");
    });

    it("the web catalog lists all four allmodels.io abliterated models", () => {
        const ids = CATALOG.filter((m) => m.abliterated).map((m) => m.id);
        expect(ids).toEqual(expect.arrayContaining([
            "qwen3.8-27b-abliterated", "glm-5.3-flash-abliterated", "glm-5.3-abliterated", "deepseek-v4.1-flash-abliterated"
        ]));
    });
});
