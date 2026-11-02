import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { resolveModelDenylist, resolveOrderBlocklist } from "@/lib/moderation/blocklists";

/**
 * Kill-switch lists in settings rows (pure rules in lib/moderation/blocklists.js).
 * Read on every chat request, so cached for a short while; an admin change
 * clears the cache in this process and reaches the others within CACHE_MS.
 */

const KEYS = { model_denylist: resolveModelDenylist, order_blocklist: resolveOrderBlocklist };
const CACHE_MS = 30_000;
const cache = new Map();

function withStatus(message, status) {
    return Object.assign(new Error(message), { status });
}

async function read(key) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let raw = null;
    try {
        const { data } = await getSupabaseServerClient().from("settings").select("value").eq("key", key).maybeSingle();
        raw = data?.value ?? null;
    } catch {
        // A failed read keeps the last known list rather than dropping it.
        if (hit) return hit.value;
    }
    const value = KEYS[key](raw);
    cache.set(key, { at: Date.now(), value });
    return value;
}

export function getModelDenylist() {
    return read("model_denylist");
}

export function getOrderBlocklist() {
    return read("order_blocklist");
}

export async function getBlocklists() {
    const [model_denylist, order_blocklist] = await Promise.all([getModelDenylist(), getOrderBlocklist()]);
    return { model_denylist, order_blocklist };
}

/** Admin: replace one or both lists. Each list is replaced whole, not merged. */
export async function updateBlocklists(patch, { actor } = {}) {
    const supabase = getSupabaseServerClient();
    const now = new Date().toISOString();
    for (const key of Object.keys(KEYS)) {
        if (patch?.[key] === undefined) continue;
        const value = KEYS[key](patch[key]);
        const { error } = await supabase.from("settings").upsert(
            { key, value: { ...value, updated_by: actor ?? null }, updated_at: now },
            { onConflict: "key" }
        );
        if (error) throw withStatus(error.message, 500);
        cache.delete(key);
    }
    return getBlocklists();
}
