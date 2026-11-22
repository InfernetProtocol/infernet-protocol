/**
 * Which models need a GPU, and so are never served free.
 *
 * Anthony 2026-11-22: "we need to charge for anything that requires a gpu".
 * The free tier (anonymous callers, an empty balance, an unpriced model) was
 * served on any model, and ALIAS_PREFERENCE put the 9B uncensored model first,
 * so every free "auto" chat ran on a GPU node and paid it nothing.
 *
 * Pure and client-safe: no imports beyond the catalog.
 *
 * A model is GPU-class when:
 *   - it is a hosted cloud model (@cf/..., Workers AI): we pay per call; or
 *   - its parameter count is above `free_max_params_b` (default 4: the 4B is
 *     the house default for CPU nodes since c0mpute 0.3.96), read from the
 *     name (":9b", "-27b", "8x7b") or, failing that, the model catalog; or
 *   - an admin lists it in `gpu_models`.
 * `free_models` forces a model free-eligible. Unknown size => free-eligible,
 * so a fine-tune named "...:latest" is not refused for its name alone.
 */
import { CATALOG } from "../model-catalog.js";

export const DEFAULT_FREE_MAX_PARAMS_B = 4;

const HOSTED_PREFIX_RE = /^@cf\//i;
// "8x7b" (MoE) first, then a plain "9b" / "0.8b" token bounded by a separator.
const MOE_RE = /(?:^|[^a-z0-9.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z0-9])/i;
const PARAMS_RE = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/gi;

function norm(name) {
    return String(name ?? "").trim().toLowerCase().replace(/^hf:/, "");
}

/** Parameter count in billions from a model name, or from the catalog; null when unknown. */
export function paramsBillionsOf(name) {
    const n = norm(name);
    if (!n) return null;
    const moe = n.match(MOE_RE);
    if (moe) return Number(moe[1]) * Number(moe[2]);
    let best = null;
    for (const m of n.matchAll(PARAMS_RE)) {
        const v = Number(m[1]);
        if (Number.isFinite(v) && (best == null || v > best)) best = v;
    }
    if (best != null) return best;
    const hit = CATALOG.find((c) => norm(c.pull) === n || norm(c.hf) === n || c.id === n);
    return hit && Number.isFinite(hit.paramsB) ? hit.paramsB : null;
}

function listOf(v) {
    return Array.isArray(v) ? v.map(norm).filter(Boolean) : [];
}

/** Resolve the GPU policy from the interactive_billing settings row (or defaults). */
export function resolveGpuPolicy(config = {}) {
    const max = Number(config?.free_max_params_b);
    return {
        gpu_requires_balance: config?.gpu_requires_balance !== false,
        free_max_params_b: Number.isFinite(max) && max >= 0 ? max : DEFAULT_FREE_MAX_PARAMS_B,
        gpu_models: listOf(config?.gpu_models),
        free_models: listOf(config?.free_models)
    };
}

/** True when `model` needs a GPU and so must be paid for. */
export function isGpuModel(model, config = {}) {
    const n = norm(model);
    if (!n) return false;
    const policy = resolveGpuPolicy(config);
    if (policy.free_models.includes(n)) return false;
    if (policy.gpu_models.includes(n)) return true;
    if (HOSTED_PREFIX_RE.test(n)) return true;
    const b = paramsBillionsOf(n);
    return b != null && b > policy.free_max_params_b;
}

/** True when a free-tier caller may run `model` (policy off => everything is). */
export function freeTierAllows(model, config = {}) {
    if (!resolveGpuPolicy(config).gpu_requires_balance) return true;
    return !isGpuModel(model, config);
}
