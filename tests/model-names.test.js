import { describe, expect, it } from "vitest";
import { ALLMODELS_IDS, matchServedModel, modelNameVariants } from "../apps/web/lib/model-names.js";
import { CATALOG } from "../apps/web/lib/model-catalog.js";

const OLLAMA_QWEN = "huihui_ai/Qwen3.8-abliterated:27b";

describe("model name synonyms", () => {
    it("routes allmodels.io's id to a node serving the Ollama tag", () => {
        expect(matchServedModel(["qwen2.5:7b", OLLAMA_QWEN], "qwen/qwen3.8-27b-abliterated")).toBe(OLLAMA_QWEN);
    });

    it("routes the catalog id and HF repo too, case-insensitively", () => {
        expect(matchServedModel([OLLAMA_QWEN], "qwen3.8-27b-abliterated")).toBe(OLLAMA_QWEN);
        expect(matchServedModel([OLLAMA_QWEN], "munekazu/huihui-qwen3.8-27b-abliterated-fp8")).toBe(OLLAMA_QWEN);
    });

    it("matches a vLLM-only model served as hf:<repo>", () => {
        const served = ["hf:dealignai/GLM-5.3-ABLITERATED-NVFP4"];
        expect(matchServedModel(served, "z-ai/glm-5.3-abliterated")).toBe(served[0]);
        expect(matchServedModel(served, "dealignai/GLM-5.3-ABLITERATED-NVFP4")).toBe(served[0]);
    });

    it("works for every catalog model, not only the abliterated ones", () => {
        expect(matchServedModel(["qwen2.5:7b"], "Qwen/Qwen2.5-7B-Instruct")).toBe("qwen2.5:7b");
    });

    it("prefers an exact match and never crosses models", () => {
        expect(matchServedModel([OLLAMA_QWEN, "qwen3.8-27b-abliterated"], "qwen3.8-27b-abliterated")).toBe("qwen3.8-27b-abliterated");
        expect(matchServedModel(["qwen2.5:7b"], "z-ai/glm-5.3-abliterated")).toBeNull();
        expect(matchServedModel(["glm-5.3-flash-abliterated"], "z-ai/glm-5.3-abliterated")).toBeNull();
    });

    it("leaves names outside the catalog matching only themselves", () => {
        expect(modelNameVariants("my-finetune:1b")).toEqual(["my-finetune:1b"]);
        expect(matchServedModel(["my-finetune:1b"], "my-finetune:1b")).toBe("my-finetune:1b");
        expect(matchServedModel(["qwen2.5:7b"], "")).toBeNull();
    });

    it("maps every allmodels id to a catalog entry", () => {
        for (const id of Object.keys(ALLMODELS_IDS)) expect(CATALOG.some((m) => m.id === id)).toBe(true);
    });
});
