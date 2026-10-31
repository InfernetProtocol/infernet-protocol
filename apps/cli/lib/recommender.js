/**
 * Local model recommender.
 *
 * Given the operator's detected (vramGb, ramGb), picks the best-fitting
 * Ollama / HuggingFace models for their hardware. Curated catalog;
 * scoring borrowed from
 * https://github.com/meattacker/local-ai-model-recommender (MIT)
 * adapted for Infernet (adds Dolphin/Hermes/Qwen-Coder, drops UI-only
 * fields).
 *
 * Used by:
 *   - `infernet model recommend`           CLI surface
 *   - `infernet setup` (default-model pick)
 *   - `infernet uncensored` (uncensored-only filter)
 */

/** Curated catalog. Each entry can be pulled via the listed pullName. */
export const CATALOG = [
    // ── ultra-light (CPU / phone-tier GPU) ──
    { id: "tinyllama",       name: "TinyLlama 1.1B",     paramsB: 1.1, vramMin: 0,  ramMin: 4,  pullName: "tinyllama",            backend: "ollama", quality: 2, speed: 10, useCases: ["chat","testing"], notes: "Good only for testing the stack." },
    { id: "llama3.2-1b",     name: "Llama 3.2 1B",       paramsB: 1,   vramMin: 0,  ramMin: 4,  pullName: "llama3.2:1b",           backend: "ollama", quality: 4, speed: 10, useCases: ["chat","summary"], notes: "Light, fast Q&A." },
    { id: "qwen2.5-1.5b",    name: "Qwen2.5 1.5B",       paramsB: 1.5, vramMin: 0,  ramMin: 4,  pullName: "qwen2.5:1.5b",          backend: "ollama", quality: 5, speed: 9,  useCases: ["chat","study","marketing"] },

    // ── light (small GPU / 16GB RAM) ──
    { id: "llama3.2-3b",     name: "Llama 3.2 3B",       paramsB: 3,   vramMin: 2,  ramMin: 8,  pullName: "llama3.2:3b",           backend: "ollama", quality: 6, speed: 8,  useCases: ["chat","study","agents"] },
    { id: "qwen2.5-3b",      name: "Qwen2.5 3B",         paramsB: 3,   vramMin: 2,  ramMin: 8,  pullName: "qwen2.5:3b",            backend: "ollama", quality: 6, speed: 8,  useCases: ["chat","study","marketing"] },
    { id: "phi4-mini",       name: "Phi-4 Mini 3.8B",    paramsB: 3.8, vramMin: 4,  ramMin: 8,  pullName: "phi4-mini",             backend: "ollama", quality: 8, speed: 7,  useCases: ["chat","study","agents","coding"] },
    { id: "gemma3-4b",       name: "Gemma 3 4B (vision)",paramsB: 4,   vramMin: 4,  ramMin: 8,  pullName: "gemma3:4b",             backend: "ollama", quality: 7, speed: 7,  useCases: ["chat","vision","study"] },

    // ── 7-8B (RTX 3060/4060+, 16GB+ RAM) ──
    { id: "qwen2.5-7b",      name: "Qwen2.5 7B",         paramsB: 7,   vramMin: 6,  ramMin: 16, pullName: "qwen2.5:7b",            backend: "ollama", quality: 8, speed: 6,  useCases: ["chat","study","coding","agents","marketing"] },
    { id: "llama3.1-8b",     name: "Llama 3.1 8B",       paramsB: 8,   vramMin: 6,  ramMin: 16, pullName: "llama3.1:8b",           backend: "ollama", quality: 8, speed: 6,  useCases: ["chat","study","agents"] },
    { id: "mistral-7b",      name: "Mistral 7B",         paramsB: 7,   vramMin: 6,  ramMin: 16, pullName: "mistral:7b",            backend: "ollama", quality: 7, speed: 6,  useCases: ["chat","study","coding"] },
    { id: "qwen2.5-coder-7b",name: "Qwen2.5 Coder 7B",   paramsB: 7,   vramMin: 6,  ramMin: 16, pullName: "qwen2.5-coder:7b",      backend: "ollama", quality: 9, speed: 6,  useCases: ["coding","agents"], notes: "Best 7B coding model." },
    { id: "dolphin3-8b",     name: "Dolphin 3 8B (uncensored)", paramsB: 8, vramMin: 6, ramMin: 16, pullName: "dolphin3:8b",       backend: "ollama", quality: 8, speed: 6,  useCases: ["chat","uncensored"], uncensored: true, notes: "Eric Hartford's Dolphin series, no alignment." },
    { id: "deepseek-r1-7b",  name: "DeepSeek-R1 7B",     paramsB: 7,   vramMin: 6,  ramMin: 16, pullName: "deepseek-r1:7b",        backend: "ollama", quality: 8, speed: 4,  useCases: ["study","coding","research","reasoning"], notes: "Reasoning-focused; slower because it thinks." },
    { id: "hermes3-llama3-8b",name:"Hermes 3 Llama-3.1 8B (uncensored)", paramsB: 8, vramMin: 8, ramMin: 16, pullName: "hf:NousResearch/Hermes-3-Llama-3.1-8B", backend: "vllm", quality: 8, speed: 6, useCases: ["chat","uncensored","agents"], uncensored: true },

    // ── 13-14B (16GB+ VRAM) ──
    { id: "qwen2.5-14b",     name: "Qwen2.5 14B",        paramsB: 14,  vramMin: 12, ramMin: 32, pullName: "qwen2.5:14b",           backend: "ollama", quality: 9, speed: 5,  useCases: ["chat","coding","study","agents","marketing"] },
    { id: "qwen2.5-coder-14b",name:"Qwen2.5 Coder 14B",  paramsB: 14,  vramMin: 12, ramMin: 32, pullName: "qwen2.5-coder:14b",     backend: "ollama", quality: 9, speed: 5,  useCases: ["coding","agents"] },

    // ── 32B (24GB+ VRAM, RTX 4090 / A100 sweet spot) ──
    { id: "qwen3.5-9b-heretic", name: "Qwen3.5 9B Heretic (uncensored)", paramsB: 9, vramMin: 24, ramMin: 32, pullName: "hf:DavidAU/Qwen3.5-9B-Claude-4.6-HighIQ-THINKING-HERETIC-UNCENSORED", backend: "vllm", quality: 8, speed: 6, useCases: ["chat","uncensored","vision","agents","study"], uncensored: true },
    { id: "qwen2.5-32b",     name: "Qwen2.5 32B",        paramsB: 32,  vramMin: 24, ramMin: 48, pullName: "qwen2.5:32b",           backend: "ollama", quality: 9, speed: 4,  useCases: ["chat","coding","study","agents","marketing","research"], notes: "Single-80GB-GPU sweet spot." },
    { id: "qwen2.5-coder-32b",name:"Qwen2.5 Coder 32B",  paramsB: 32,  vramMin: 24, ramMin: 48, pullName: "qwen2.5-coder:32b",     backend: "ollama", quality: 10, speed: 4, useCases: ["coding","agents"] },

    // ── 70B (40-80GB VRAM, Q4 fits 24GB) ──
    { id: "llama3.3-70b",    name: "Llama 3.3 70B",      paramsB: 70,  vramMin: 40, ramMin: 64, pullName: "llama3.3:70b",          backend: "ollama", quality: 10, speed: 3, useCases: ["chat","study","coding","agents","marketing"], notes: "Frontier-class at home with 80GB." },
    { id: "qwen2.5-72b",     name: "Qwen2.5 72B",        paramsB: 72,  vramMin: 40, ramMin: 64, pullName: "qwen2.5:72b",           backend: "ollama", quality: 10, speed: 3, useCases: ["chat","coding","study","agents","marketing","research"] },

    // ── MoE (high VRAM, vLLM only) ──
    { id: "mixtral-8x7b",    name: "Mixtral 8x7B",       paramsB: 47,  vramMin: 30, ramMin: 64, pullName: "dolphin-mixtral:8x7b",  backend: "ollama", quality: 9, speed: 5,  useCases: ["chat","coding","uncensored"], uncensored: true },

    // ── abliterated (the open-weight models allmodels.io routes as "abliterated") ──
    { id: "qwen3.8-27b-abliterated", name: "Qwen3.8 27B abliterated (uncensored)", paramsB: 27.8, vramMin: 24, ramMin: 32, pullName: "huihui_ai/Qwen3.8-abliterated:27b", backend: "ollama", quality: 10, speed: 5, useCases: ["chat","uncensored","coding","agents","study"], uncensored: true, abliterated: true, notes: "huihui-ai abliteration; default for 24 GB+ self-hosted nodes." },

    // ── flagship / cluster-tier (multi-GPU or cloud; won't fit a single card) ──
    { id: "glm-5.3-flash-abliterated", name: "GLM-5.3 Flash 321B NVFP4 (abliterated)", paramsB: 321, vramMin: 256, ramMin: 256, pullName: "hf:edp1096/Huihui-GLM-5.3-Flash-abliterated-NVFP4", backend: "vllm", quality: 10, speed: 3, useCases: ["chat","uncensored","coding","agents"], uncensored: true, abliterated: true, notes: "NVFP4 needs Blackwell GPUs." },
    { id: "glm-5.3-abliterated", name: "GLM-5.3 753B NVFP4 (abliterated)", paramsB: 753, vramMin: 512, ramMin: 512, pullName: "hf:dealignai/GLM-5.3-ABLITERATED-NVFP4", backend: "vllm", quality: 10, speed: 2, useCases: ["chat","uncensored","coding","agents"], uncensored: true, abliterated: true, notes: "NVFP4 needs Blackwell GPUs." },
    { id: "deepseek-v4.1-flash-abliterated", name: "DeepSeek V4.1 Flash 763B (abliterated)", paramsB: 763, vramMin: 640, ramMin: 640, pullName: "hf:mrfakename/DeepSeek-V4.1-Flash-1017-abliterated", backend: "vllm", quality: 10, speed: 2, useCases: ["chat","uncensored","coding","agents","reasoning"], uncensored: true, abliterated: true },
    { id: "glm-5.2-uncensored", name: "GLM-5.2 754B FP8 (uncensored)", paramsB: 754, vramMin: 768, ramMin: 768, pullName: "hf:zandenAI/GLM-5.2-FP8-Uncensored", backend: "vllm", quality: 10, speed: 2, useCases: ["chat","uncensored","cybersecurity","agents"], uncensored: true, gated: true }
];

/**
 * Score a model against detected hardware + use case.
 * Higher = better fit. Models that don't meet vramMin are scored lower
 * but not excluded — operators can still pull with --force.
 */
function scoreModel(m, { vramGb, ramGb, useCase }) {
    let score = 0;

    // Hardware fit — biggest factor.
    if (m.vramMin === 0 || vramGb >= m.vramMin) {
        // Fits comfortably; reward larger models the more headroom we have
        score += 50 + Math.min(40, (vramGb - m.vramMin) * 1.5);
    } else {
        // Won't fit — heavily penalize, scaled by how short we are
        score -= 80 - Math.min(60, (m.vramMin - vramGb) * 4);
    }
    if (ramGb >= m.ramMin) score += 10;
    else score -= 20;

    // Quality bias for use-case match
    score += m.quality * 4;
    if (useCase && m.useCases?.includes(useCase)) score += 25;
    // Self-hosted default: prefer an abliterated model whenever it fits.
    if (m.abliterated && (m.vramMin === 0 || vramGb >= m.vramMin)) score += 20;

    // CPU-only systems prefer speed
    if (vramGb === 0) score += m.speed * 3 - m.paramsB * 2;

    return score;
}

/**
 * Return the top N models for the given hardware + use case.
 * @param {object} opts
 * @param {number} opts.vramGb
 * @param {number} opts.ramGb
 * @param {string} [opts.useCase]    chat | marketing | research | coding | study | agents | uncensored | vision
 * @param {boolean} [opts.uncensoredOnly]
 * @param {number} [opts.limit=3]
 * @returns {Array<{model, score, fits}>}
 */
export function recommendModels({ vramGb = 0, ramGb = 0, useCase, uncensoredOnly = false, limit = 3 } = {}) {
    return CATALOG
        .filter((m) => uncensoredOnly ? m.uncensored : true)
        .filter((m) => useCase ? m.useCases?.includes(useCase) : true)
        .map((m) => ({
            model: m,
            score: scoreModel(m, { vramGb, ramGb, useCase }),
            fits: vramGb >= m.vramMin && ramGb >= m.ramMin
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

/** Default model for `infernet setup` based on detected hardware. */
export function pickDefaultModel({ vramGb = 0, ramGb = 0 } = {}) {
    const top = recommendModels({ vramGb, ramGb, limit: 1 })[0];
    return top?.model ?? null;
}
