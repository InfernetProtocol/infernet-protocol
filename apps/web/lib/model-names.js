/**
 * Other names for the same model.
 *
 * A node advertises a model under the name it installed it by: an Ollama tag
 * ("huihui_ai/Qwen3.8-abliterated:27b") or "hf:<repo>" for a vLLM-only model.
 * Callers ask by whatever name they know: the catalog id, the HuggingFace repo
 * or, for the abliterated models, allmodels.io's id
 * ("qwen/qwen3.8-27b-abliterated"). Each catalog entry ties those names
 * together so a request by any of them reaches a node serving the model.
 * Names outside the catalog still match only themselves.
 */
import { CATALOG } from "./model-catalog.js";

// allmodels.io model ids (its /api/llm/models), by catalog id.
export const ALLMODELS_IDS = {
    "qwen3.8-27b-abliterated": "qwen/qwen3.8-27b-abliterated",
    "glm-5.3-flash-abliterated": "z-ai/glm-5.3-flash-abliterated",
    "glm-5.3-abliterated": "z-ai/glm-5.3-abliterated",
    "deepseek-v4.1-flash-abliterated": "deepseek/deepseek-v4.1-flash-abliterated"
};

function namesOf(m) {
    const names = [m.id, m.pull, ALLMODELS_IDS[m.id]];
    if (m.pull?.startsWith("hf:")) names.push(m.pull.slice(3));
    if (m.hf) names.push(m.hf, `hf:${m.hf}`);
    return names.filter(Boolean);
}

const key = (name) => name.trim().toLowerCase();

// lowercased name -> every name of that model
const GROUPS = new Map();
for (const m of CATALOG) {
    const names = namesOf(m);
    for (const n of names) {
        const k = key(n);
        // First entry wins: an id shared by two entries must not merge them.
        if (!GROUPS.has(k)) GROUPS.set(k, names);
    }
}

/** Every lowercased name that means the same model as `name`, itself included. */
export function modelNameVariants(name) {
    if (typeof name !== "string" || !name.trim()) return [];
    const group = GROUPS.get(key(name));
    return [...new Set([key(name), ...(group ?? []).map(key)])];
}

/**
 * The name in `served` (a node's served_models) that serves `requested`, or
 * null. An exact match wins over a synonym.
 */
export function matchServedModel(served, requested) {
    if (!Array.isArray(served) || typeof requested !== "string" || !requested) return null;
    if (served.includes(requested)) return requested;
    const wanted = new Set(modelNameVariants(requested));
    return served.find((s) => typeof s === "string" && wanted.has(key(s))) ?? null;
}
