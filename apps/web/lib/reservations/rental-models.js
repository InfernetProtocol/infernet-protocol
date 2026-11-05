/**
 * The models a rented GPU can be booked to serve, and the VRAM each needs.
 *
 * Two lists, because the two serving runtimes we rent behind take different
 * names for the same weights:
 *
 *   - VLLM_MODELS are Hugging Face repo ids, served by vLLM. Every one is open
 *     weights and ungated (no HF token needed to pull), because the rented box
 *     pulls them itself and we are not putting a license-accepting token on
 *     someone else's hardware.
 *   - OLLAMA_MODELS are Ollama tags, for providers whose GPU image is Ollama
 *     rather than vLLM (Thunder Compute's `ollama` template). Same weights,
 *     quantized, so they fit in less VRAM than the vLLM figure.
 *
 * `vram_gb` is what the model needs at an 8k context with room for KV cache,
 * not the file size. It is the gate on which tier may serve which model, so it
 * errs high: a booking that will not load is worse than one we refused.
 */

/** Hugging Face repo ids served on vLLM. Ungated only. */
export const VLLM_MODELS = Object.freeze([
    { id: "Qwen/Qwen2.5-1.5B-Instruct", params_b: 1.5, vram_gb: 8 },
    { id: "Qwen/Qwen2.5-3B-Instruct", params_b: 3, vram_gb: 10 },
    { id: "Qwen/Qwen2.5-7B-Instruct-AWQ", params_b: 7, vram_gb: 10 },
    { id: "Qwen/Qwen2.5-14B-Instruct-AWQ", params_b: 14, vram_gb: 16 },
    { id: "Qwen/Qwen2.5-Coder-14B-Instruct-AWQ", params_b: 14, vram_gb: 16 },
    { id: "Qwen/Qwen2.5-7B-Instruct", params_b: 7, vram_gb: 24 },
    { id: "Qwen/Qwen2.5-32B-Instruct-AWQ", params_b: 32, vram_gb: 24 },
    { id: "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ", params_b: 32, vram_gb: 24 },
    { id: "Qwen/Qwen2.5-72B-Instruct-AWQ", params_b: 72, vram_gb: 48 }
]);

/** Ollama tags, for providers that serve through Ollama. */
export const OLLAMA_MODELS = Object.freeze([
    { id: "qwen2.5:1.5b", params_b: 1.5, vram_gb: 4 },
    { id: "qwen2.5:3b", params_b: 3, vram_gb: 6 },
    { id: "qwen2.5:7b", params_b: 7, vram_gb: 8 },
    { id: "qwen2.5-coder:7b", params_b: 7, vram_gb: 8 },
    { id: "qwen2.5:14b", params_b: 14, vram_gb: 12 },
    { id: "qwen2.5-coder:14b", params_b: 14, vram_gb: 12 },
    { id: "qwen2.5:32b", params_b: 32, vram_gb: 24 },
    { id: "qwen2.5-coder:32b", params_b: 32, vram_gb: 24 },
    { id: "qwen2.5:72b", params_b: 72, vram_gb: 48 }
]);

/**
 * The ids from `models` that fit in `vramGb`. Infinity is allowed and means
 * "every model in the list" — callers use it to ask whether an id is known at
 * all, so it must not be read as zero VRAM.
 */
export function fitting(models, vramGb) {
    const cap = Number(vramGb);
    if (Number.isNaN(cap)) return [];
    return models.filter((m) => m.vram_gb <= cap).map((m) => m.id);
}

/** The largest parameter count in `models` that fits in `vramGb`, or 0. */
export function largestFitting(models, vramGb) {
    const cap = Number(vramGb);
    if (Number.isNaN(cap)) return 0;
    const fits = models.filter((m) => m.vram_gb <= cap).map((m) => m.params_b);
    return fits.length ? Math.max(...fits) : 0;
}

/**
 * The shared rule for a rented-GPU order: exactly one model, and it has to fit
 * the card. Returns an error string for the caller to hand back, or null.
 */
export function oneFittingModelError({ gpuClass, label, models, catalog, vramGb }) {
    if (models.length !== 1) return `${gpuClass} orders serve exactly one model`;
    const fit = fitting(catalog, vramGb);
    return fit.includes(models[0]) ? null : `${models[0]} is not offered on ${label}; pick one of ${fit.join(", ")}`;
}
