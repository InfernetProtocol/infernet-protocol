import { describe, it, expect } from "vitest";
import { paramsBillionsOf, isGpuModel, freeTierAllows, resolveGpuPolicy } from "../apps/web/lib/billing/gpu-models.js";
import { interactiveModeFor, resolveInteractiveConfig, adminFallback } from "../apps/web/lib/billing/interactive.js";
import { resolveInferencePricing } from "../apps/web/lib/billing/core.js";

describe("paramsBillionsOf", () => {
    it.each([
        ["eriktonon/qwen3.8-uncensored:9b", 9],
        ["huihui_ai/qwen3.5-abliterated:0.8b", 0.8],
        ["huihui_ai/qwen3.8-abliterated:27b", 27],
        ["deepseek-coder-v2:16b", 16],
        ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", 70],
        ["dolphin-mixtral:8x7b", 56],
        ["llama-3.2-3b:latest", 3],
        ["gemma3:4b", 4],
        ["qwen2.5:7b", 7],
        ["hf:NousResearch/Hermes-3-Llama-3.1-8B", 8]
    ])("%s -> %s", (name, b) => expect(paramsBillionsOf(name)).toBe(b));

    it("does not read a version number as a size", () => {
        expect(paramsBillionsOf("qwen3.8")).toBe(null);
    });
    it("unknown size is null", () => {
        expect(paramsBillionsOf("hf.co/profullstack/not-a-lawyer-agent-GGUF:latest")).toBe(null);
    });
    it("falls back to the catalog", () => {
        expect(paramsBillionsOf("phi4-mini")).toBe(3.8);
    });
});

describe("isGpuModel", () => {
    it("9B uncensored needs a GPU", () => expect(isGpuModel("eriktonon/qwen3.8-uncensored:9b")).toBe(true));
    it("the 4B CPU house default does not", () => expect(isGpuModel("huihui_ai/qwen3.5-abliterated:4b")).toBe(false));
    it("hosted @cf models always do", () => expect(isGpuModel("@cf/meta/llama-3.2-1b-instruct")).toBe(true));
    it("unknown size is free-eligible", () => expect(isGpuModel("hf.co/profullstack/tax-guy-agent-GGUF:latest")).toBe(false));
    it("gpu_models / free_models override", () => {
        expect(isGpuModel("tax-guy-agent", { gpu_models: ["tax-guy-agent"] })).toBe(true);
        expect(isGpuModel("qwen2.5:7b", { free_models: ["qwen2.5:7b"] })).toBe(false);
    });
    it("threshold is configurable", () => {
        expect(isGpuModel("qwen2.5:7b", { free_max_params_b: 8 })).toBe(false);
        expect(isGpuModel("gemma3:4b", { free_max_params_b: 2 })).toBe(true);
    });
    it("policy can be switched off", () => {
        expect(freeTierAllows("eriktonon/qwen3.8-uncensored:9b", { gpu_requires_balance: false })).toBe(true);
        expect(resolveGpuPolicy({}).gpu_requires_balance).toBe(true);
    });
});

describe("interactiveModeFor: GPU models are never free", () => {
    const pricing = resolveInferencePricing({ env: {} });
    const config = resolveInteractiveConfig({ settings: { enabled: true } });
    const empty = { prepaid_micro: 0, earned_micro: 0, held_micro: 0 };
    const GPU = "eriktonon/qwen3.8-uncensored:9b";
    const CPU = "huihui_ai/qwen3.5-abliterated:4b";
    const defaults = { default_model_price: { input_per_m_usd: 0.03, output_per_m_usd: 0.12 } };

    it("anonymous on a GPU model -> insufficient", () => {
        const d = interactiveModeFor({ model: GPU, pricing, config, funding: empty, defaults, signedIn: false });
        expect(d.mode).toBe("insufficient");
        expect(d.reason).toBe("gpu_requires_balance");
    });
    it("anonymous on a CPU model stays free", () => {
        expect(interactiveModeFor({ model: CPU, pricing, config, funding: empty, defaults, signedIn: false }).mode).toBe("free");
    });
    it("anonymous with no model stays free (router keeps it on CPU)", () => {
        expect(interactiveModeFor({ model: undefined, pricing, config, funding: empty, defaults, signedIn: false }).mode).toBe("free");
    });
    it("signed in, empty balance, GPU model -> insufficient", () => {
        expect(interactiveModeFor({ model: GPU, pricing, config, funding: empty, defaults }).mode).toBe("insufficient");
    });
    it("unpriced GPU model is not free either", () => {
        const d = interactiveModeFor({ model: "devstral:24b", pricing: { ...pricing, models: {} }, config, funding: empty, defaults: null });
        expect(d.mode).toBe("insufficient");
    });
    it("metering off charges nobody, so nothing is refused", () => {
        const off = resolveInteractiveConfig({ settings: { enabled: false } });
        expect(interactiveModeFor({ model: GPU, pricing, config: off, funding: empty, signedIn: false }).mode).toBe("free");
    });
    it("policy off restores the old free tier", () => {
        const loose = resolveInteractiveConfig({ settings: { enabled: true, gpu_requires_balance: false } });
        expect(interactiveModeFor({ model: GPU, pricing, config: loose, funding: empty, defaults, signedIn: false }).mode).toBe("free");
    });
    it("admins are still served unmetered", () => {
        const d = interactiveModeFor({ model: GPU, pricing, config, funding: empty, defaults });
        expect(adminFallback({ isAdmin: true, decision: d }).mode).toBe("admin");
    });
    it("settings row carries the policy", () => {
        const c = resolveInteractiveConfig({ settings: { free_max_params_b: 8, gpu_models: ["X"] } });
        expect(c.free_max_params_b).toBe(8);
        expect(c.gpu_models).toEqual(["x"]);
        expect(c.gpu_requires_balance).toBe(true);
    });
});
