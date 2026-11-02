/**
 * Kill switches that live in settings rows (pure half; lib/data/blocklists.js
 * reads and writes them):
 *
 *   'model_denylist'   { models: ["name", ...] }   chat refuses these models,
 *                      by any of their names (lib/model-names.js)
 *   'order_blocklist'  { emails: [...], payers: [...] }   self-serve orders
 *                      refuse these buyer emails and payer addresses
 *
 * Provider bans are a column (providers.disabled_at), not a list here.
 */
import { matchServedModel } from "../model-names.js";

const MAX_ENTRIES = 500;

function cleanList(v, { lower = true } = {}) {
    const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : [];
    const out = [];
    for (const x of raw) {
        if (typeof x !== "string") continue;
        const t = x.trim();
        if (!t || t.length > 200) continue;
        const n = lower ? t.toLowerCase() : t;
        if (!out.includes(n)) out.push(n);
        if (out.length >= MAX_ENTRIES) break;
    }
    return out;
}

/** Normalise the 'model_denylist' settings value (or an admin patch). */
export function resolveModelDenylist(value) {
    const v = Array.isArray(value) ? { models: value } : value && typeof value === "object" ? value : {};
    return { models: cleanList(v.models, { lower: false }) };
}

/** Normalise the 'order_blocklist' settings value (or an admin patch). */
export function resolveOrderBlocklist(value) {
    const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return { emails: cleanList(v.emails), payers: cleanList(v.payers) };
}

/** The denylisted name a request hits, or null. Any name of the model counts. */
export function deniedModel(denylist, names) {
    const models = denylist?.models ?? [];
    if (models.length === 0) return null;
    const lowered = models.map((m) => m.toLowerCase());
    for (const name of (Array.isArray(names) ? names : [names])) {
        if (typeof name !== "string" || !name) continue;
        if (lowered.includes(name.toLowerCase())) return name;
        if (matchServedModel(models, name) !== null) return name;
    }
    return null;
}

/** Why an order from this email / payer is refused, or null. */
export function orderBlockReason(blocklist, { email, payer } = {}) {
    const e = typeof email === "string" ? email.trim().toLowerCase() : "";
    const p = typeof payer === "string" ? payer.trim().toLowerCase() : "";
    if (e && (blocklist?.emails ?? []).includes(e)) return "email";
    if (e) {
        const domain = e.split("@")[1];
        if (domain && (blocklist?.emails ?? []).includes(`@${domain}`)) return "email";
    }
    if (p && (blocklist?.payers ?? []).includes(p)) return "payer";
    return null;
}
