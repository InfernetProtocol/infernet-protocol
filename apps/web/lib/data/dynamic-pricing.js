import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { resolveDynamicConfig, marketSignal } from "@/lib/billing/dynamic-price";
import { capOf, activeOf } from "@/lib/routing/smart-pick";
import { matchServedModel } from "@/lib/model-names";

/**
 * The live supply-vs-demand snapshot the dynamic default price is built on
 * (the curve itself is in lib/billing/dynamic-price.js).
 *
 * Supply is the capacity of the nodes that can serve the model; demand is how
 * much of that capacity is busy. Both are measured the same way the ROUTER
 * measures them (lib/routing/smart-pick.js: capOf, activeOf), so the price a
 * buyer is quoted and the load the router sees cannot drift apart.
 */

function db(supabase) {
    return supabase ?? getSupabaseServerClient();
}

/** The dynamic curve's settings, off the same `inference_pricing` row. */
export async function getDynamicConfig(supabase) {
    let settings = null;
    try {
        const { data } = await db(supabase).from("settings").select("value").eq("key", "inference_pricing").maybeSingle();
        settings = data?.value ?? null;
    } catch {
        /* defaults + env */
    }
    return resolveDynamicConfig({ env: process.env, settings });
}

const LIVE_WINDOW_MS = 2 * 60 * 1000;
const INFLIGHT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Supply and demand for one model right now.
 *
 * Live is the same definition routing uses: available, not disabled, seen in
 * the last two minutes. A node that cannot take work is not supply, so it must
 * not make the price look cheap.
 */
export async function marketSnapshot({ model, supabase }) {
    const client = db(supabase);
    const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();

    const { data: rows, error } = await client
        .from("providers")
        .select("id, specs, trust_tier")
        .eq("status", "available")
        .is("disabled_at", null)
        .gte("last_seen", since);
    if (error) throw new Error(error.message);

    // Only nodes that actually serve this model are its supply. Matched by any
    // of the model's names, the same way routing matches it.
    const serving = (rows ?? []).filter((p) => {
        if ((p.trust_tier ?? "public") === "private") return false;
        if (!model) return true;
        return matchServedModel(p?.specs?.served_models, model) !== null;
    });

    const inflight = await inflightFor(client, serving.map((p) => p.id));
    return marketSignal({ providers: serving, inflight, capOf, activeOf });
}

/**
 * Jobs assigned or running per provider. Heartbeats report active_jobs only
 * every minute or so, so a burst in between would look like idle capacity and
 * under-price exactly when demand spiked. Never throws: without this the
 * signal falls back to what the nodes last reported.
 */
async function inflightFor(client, ids) {
    if (!ids || ids.length === 0) return {};
    try {
        const since = new Date(Date.now() - INFLIGHT_WINDOW_MS).toISOString();
        const { data, error } = await client
            .from("jobs")
            .select("provider_id")
            .in("status", ["assigned", "running"])
            .in("provider_id", ids)
            .gte("created_at", since)
            .limit(5000);
        if (error) return {};
        const out = {};
        for (const row of data ?? []) {
            if (!row?.provider_id) continue;
            out[row.provider_id] = (out[row.provider_id] ?? 0) + 1;
        }
        return out;
    } catch {
        return {};
    }
}
