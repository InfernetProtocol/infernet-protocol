/**
 * Web-side model catalog + recommender.
 *
 * Mirrors apps/cli/lib/recommender.js so the web "Manage models" dialog
 * surfaces the same recommendations as the CLI's `infernet model
 * recommend`. Client-bundled (no Node deps).
 *
 * Source data: ported from
 * github.com/meattacker/local-ai-model-recommender (MIT) +
 * Infernet additions (Dolphin/Hermes/Qwen-Coder, vLLM-backend models).
 */

// backend/hf policy:
//   Every model carries `pull` (an Ollama tag, for CPU/Mac nodes) AND, where an
//   ungated vLLM-servable HF repo exists, an `hf` repo. The NODE decides at
//   install time: if it has vLLM (a GPU box) it serves the HF repo on vLLM;
//   otherwise it pulls the Ollama tag. So `backend: "vllm"` here means "vLLM on
//   a GPU node, Ollama fallback elsewhere" — it is NOT Ollama-only.
//   Gated HF repos (Llama, Gemma, Mistral — require license acceptance) are left
//   without `hf` so they don't 401 on vLLM; they stay on Ollama until a user
//   supplies a token with access via the free-text `hf:` install.
export const CATALOG = [
    // ── ultra-light (CPU / phone-tier GPU) ──
    { id: "tinyllama",        name: "TinyLlama 1.1B",          paramsB: 1.1, vramMin: 0,  ramMin: 4,  pull: "tinyllama",           hf: "TinyLlama/TinyLlama-1.1B-Chat-v1.0",   backend: "vllm",   quality: 2, useCases: ["chat", "testing"] },
    { id: "llama3.2-1b",      name: "Llama 3.2 1B",            paramsB: 1,   vramMin: 0,  ramMin: 4,  pull: "llama3.2:1b",                            backend: "ollama", quality: 4, useCases: ["chat"] },
    { id: "qwen2.5-1.5b",     name: "Qwen2.5 1.5B",            paramsB: 1.5, vramMin: 0,  ramMin: 4,  pull: "qwen2.5:1.5b",        hf: "Qwen/Qwen2.5-1.5B-Instruct",           backend: "vllm",   quality: 5, useCases: ["chat", "study"] },
    // ── light ──
    { id: "llama3.2-3b",      name: "Llama 3.2 3B",            paramsB: 3,   vramMin: 2,  ramMin: 8,  pull: "llama3.2:3b",                            backend: "ollama", quality: 6, useCases: ["chat", "study", "agents"] },
    { id: "qwen2.5-3b",       name: "Qwen2.5 3B",              paramsB: 3,   vramMin: 2,  ramMin: 8,  pull: "qwen2.5:3b",          hf: "Qwen/Qwen2.5-3B-Instruct",             backend: "vllm",   quality: 6, useCases: ["chat", "study"] },
    { id: "phi4-mini",        name: "Phi-4 Mini 3.8B",         paramsB: 3.8, vramMin: 4,  ramMin: 8,  pull: "phi4-mini",           hf: "microsoft/Phi-4-mini-instruct",        backend: "vllm",   quality: 8, useCases: ["chat", "study", "agents", "coding"] },
    { id: "gemma3-4b",        name: "Gemma 3 4B (vision)",     paramsB: 4,   vramMin: 4,  ramMin: 8,  pull: "gemma3:4b",                              backend: "ollama", quality: 7, useCases: ["chat", "vision", "study"] },
    // ── 7-8B ──
    { id: "qwen2.5-7b",       name: "Qwen2.5 7B",              paramsB: 7,   vramMin: 6,  ramMin: 16, pull: "qwen2.5:7b",          hf: "Qwen/Qwen2.5-7B-Instruct",             backend: "vllm",   quality: 8, useCases: ["chat", "study", "coding", "agents"] },
    { id: "llama3.1-8b",      name: "Llama 3.1 8B",            paramsB: 8,   vramMin: 6,  ramMin: 16, pull: "llama3.1:8b",                            backend: "ollama", quality: 8, useCases: ["chat", "study", "agents"] },
    { id: "mistral-7b",       name: "Mistral 7B",              paramsB: 7,   vramMin: 6,  ramMin: 16, pull: "mistral:7b",                             backend: "ollama", quality: 7, useCases: ["chat", "study", "coding"] },
    { id: "qwen2.5-coder-7b", name: "Qwen2.5 Coder 7B",        paramsB: 7,   vramMin: 6,  ramMin: 16, pull: "qwen2.5-coder:7b",    hf: "Qwen/Qwen2.5-Coder-7B-Instruct",       backend: "vllm",   quality: 9, useCases: ["coding", "agents"] },
    { id: "dolphin3-8b",      name: "Dolphin 3 8B (uncensored)", paramsB: 8, vramMin: 6,  ramMin: 16, pull: "dolphin3:8b",         hf: "cognitivecomputations/Dolphin3.0-Llama3.1-8B", backend: "vllm", quality: 8, useCases: ["chat", "uncensored"], uncensored: true },
    { id: "deepseek-r1-7b",   name: "DeepSeek-R1 7B",          paramsB: 7,   vramMin: 6,  ramMin: 16, pull: "deepseek-r1:7b",      hf: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", backend: "vllm", quality: 8, useCases: ["study", "coding", "research", "agents"] },
    { id: "hermes3-llama3-8b",name: "Hermes 3 Llama-3.1 8B (uncensored)", paramsB: 8, vramMin: 8, ramMin: 16, pull: "hf:NousResearch/Hermes-3-Llama-3.1-8B", backend: "vllm", quality: 8, useCases: ["chat", "uncensored", "agents"], uncensored: true },
    // ── 13-14B ──
    { id: "qwen2.5-14b",      name: "Qwen2.5 14B",             paramsB: 14,  vramMin: 12, ramMin: 32, pull: "qwen2.5:14b",         hf: "Qwen/Qwen2.5-14B-Instruct",            backend: "vllm",   quality: 9, useCases: ["chat", "coding", "study", "agents"] },
    { id: "qwen2.5-coder-14b",name: "Qwen2.5 Coder 14B",       paramsB: 14,  vramMin: 12, ramMin: 32, pull: "qwen2.5-coder:14b",   hf: "Qwen/Qwen2.5-Coder-14B-Instruct",      backend: "vllm",   quality: 9, useCases: ["coding", "agents"] },
    // ── 32B (24GB+ sweet spot) ──
    { id: "qwen3.5-9b-heretic", name: "Qwen3.5 9B Heretic (uncensored, thinking, vision)", paramsB: 9, vramMin: 24, ramMin: 32, pull: "hf:DavidAU/Qwen3.5-9B-Claude-4.6-HighIQ-THINKING-HERETIC-UNCENSORED", backend: "vllm", quality: 8, useCases: ["chat", "uncensored", "vision", "agents", "study"], uncensored: true },
    { id: "qwen2.5-32b",      name: "Qwen2.5 32B",             paramsB: 32,  vramMin: 24, ramMin: 48, pull: "qwen2.5:32b",         hf: "Qwen/Qwen2.5-32B-Instruct",            backend: "vllm",   quality: 9, useCases: ["chat", "coding", "study", "research", "agents"] },
    { id: "qwen2.5-coder-32b",name: "Qwen2.5 Coder 32B",       paramsB: 32,  vramMin: 24, ramMin: 48, pull: "qwen2.5-coder:32b",   hf: "Qwen/Qwen2.5-Coder-32B-Instruct",      backend: "vllm",   quality: 10,useCases: ["coding", "agents"] },
    { id: "deepseek-r1-32b",  name: "DeepSeek-R1 32B",         paramsB: 32,  vramMin: 24, ramMin: 48, pull: "deepseek-r1:32b",     hf: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", backend: "vllm", quality: 9, useCases: ["study", "coding", "research", "agents"] },
    // ── 70B+ ──
    { id: "llama3.3-70b",     name: "Llama 3.3 70B",           paramsB: 70,  vramMin: 40, ramMin: 64, pull: "llama3.3:70b",                           backend: "ollama", quality: 10,useCases: ["chat", "study", "coding", "research", "agents"] },
    { id: "qwen2.5-72b",      name: "Qwen2.5 72B",             paramsB: 72,  vramMin: 40, ramMin: 64, pull: "qwen2.5:72b",         hf: "Qwen/Qwen2.5-72B-Instruct",            backend: "vllm",   quality: 10,useCases: ["chat", "coding", "study", "research", "agents"] },
    // ── MoE ──
    { id: "mixtral-8x7b",     name: "Dolphin Mixtral 8x7B",    paramsB: 47,  vramMin: 30, ramMin: 64, pull: "dolphin-mixtral:8x7b",                   backend: "ollama", quality: 9, useCases: ["chat", "coding", "uncensored"], uncensored: true },
    // ── abliterated (the open-weight models allmodels.io routes as "abliterated") ──
    { id: "qwen3.8-27b-abliterated", name: "Qwen3.8 27B abliterated (uncensored)", paramsB: 27.8, vramMin: 24, ramMin: 32, pull: "huihui_ai/Qwen3.8-abliterated:27b", hf: "munekazu/Huihui-Qwen3.8-27B-abliterated-FP8", backend: "vllm", quality: 10, useCases: ["chat", "uncensored", "coding", "agents", "study"], uncensored: true, abliterated: true },
    // ── flagship / cluster-tier (multi-GPU or cloud; won't fit a single card) ──
    { id: "glm-5.3-flash-abliterated", name: "GLM-5.3 Flash 321B NVFP4 (abliterated, Blackwell)", paramsB: 321, vramMin: 256, ramMin: 256, pull: "hf:edp1096/Huihui-GLM-5.3-Flash-abliterated-NVFP4", backend: "vllm", quality: 10, useCases: ["chat", "uncensored", "coding", "agents"], uncensored: true, abliterated: true },
    { id: "glm-5.3-abliterated", name: "GLM-5.3 753B NVFP4 (abliterated, Blackwell)", paramsB: 753, vramMin: 512, ramMin: 512, pull: "hf:dealignai/GLM-5.3-ABLITERATED-NVFP4", backend: "vllm", quality: 10, useCases: ["chat", "uncensored", "coding", "agents"], uncensored: true, abliterated: true },
    { id: "deepseek-v4.1-flash-abliterated", name: "DeepSeek V4.1 Flash 763B (abliterated)", paramsB: 763, vramMin: 640, ramMin: 640, pull: "hf:mrfakename/DeepSeek-V4.1-Flash-1017-abliterated", backend: "vllm", quality: 10, useCases: ["chat", "uncensored", "coding", "research", "agents"], uncensored: true, abliterated: true },
    { id: "glm-5.2-uncensored", name: "GLM-5.2 754B FP8 (uncensored)", paramsB: 754, vramMin: 768, ramMin: 768, pull: "hf:zandenAI/GLM-5.2-FP8-Uncensored", backend: "vllm", quality: 10, useCases: ["chat", "uncensored", "cybersecurity", "agents"], uncensored: true, gated: true }
];

/** Map sanitized vram_tier strings → representative GB for ranking. */
const TIER_TO_GB = {
    "<8gb":     6,
    "8-16gb":   12,
    "16-24gb":  20,
    "24-48gb":  36,
    ">=48gb":   64,
    "unknown":  0
};

/** Sum the representative GB across a node's GPUs. */
export function vramFromSpecs(specs) {
    const gpus = specs?.gpus ?? [];
    let total = 0;
    for (const g of gpus) {
        const tier = String(g?.vram_tier ?? "").toLowerCase();
        total += TIER_TO_GB[tier] ?? 0;
    }
    return total;
}

function scoreModel(m, { vramGb, useCase }) {
    let score = 0;
    if (m.vramMin === 0 || vramGb >= m.vramMin) {
        score += 50 + Math.min(40, (vramGb - m.vramMin) * 1.5);
    } else {
        score -= 80 - Math.min(60, (m.vramMin - vramGb) * 4);
    }
    score += m.quality * 4;
    if (useCase && m.useCases?.includes(useCase)) score += 25;
    // Self-hosted default: prefer an abliterated model whenever it fits.
    if (m.abliterated && (m.vramMin === 0 || vramGb >= m.vramMin)) score += 20;
    return score;
}

export function recommendModels({ vramGb = 0, useCase, uncensoredOnly = false, limit = 6 } = {}) {
    return CATALOG
        .filter((m) => uncensoredOnly ? m.uncensored : true)
        .filter((m) => useCase ? m.useCases?.includes(useCase) : true)
        .map((m) => ({ model: m, score: scoreModel(m, { vramGb, useCase }), fits: vramGb >= m.vramMin }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

export const USE_CASES = [
    { id: null,         label: "Any" },
    { id: "chat",       label: "Chat" },
    { id: "coding",     label: "Coding" },
    { id: "research",   label: "Research" },
    { id: "study",      label: "Study" },
    { id: "agents",     label: "Agents" },
    { id: "uncensored", label: "Uncensored" },
    { id: "vision",     label: "Vision" }
];
