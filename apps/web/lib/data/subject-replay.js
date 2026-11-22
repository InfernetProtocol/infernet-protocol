import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { createReplayCache } from "@/lib/billing/signed-subject";

/**
 * Accept each signed request id once (per trusted client).
 *
 * Two layers: a bounded in-memory cache, which catches a replay to this
 * process without a round trip, and the subject_request_ids table
 * (20261123000000_subject_request_ids.sql, primary key on the id), which
 * catches one that lands after a restart or on another instance. A database
 * that cannot be reached leaves the memory answer standing: the signature and
 * its five-minute window still hold, and refusing every signed caller because
 * Postgres blinked would meter paying people by address.
 */

const memory = createReplayCache();

export async function claimRequestId(key, { supabase } = {}) {
    if (typeof key !== "string" || !key) return false;
    if (!memory.claim(key)) return false;
    try {
        const { data, error } = await (supabase ?? getSupabaseServerClient()).rpc("subject_request_claim", { p_key: key });
        if (error) throw error;
        return data !== false;
    } catch (err) {
        console.warn(`[billed-subject] replay ledger unavailable, memory only: ${err?.message ?? err}`);
        return true;
    }
}
