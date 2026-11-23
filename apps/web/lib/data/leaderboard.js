import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { summariseLeaderboard } from "@/lib/leaderboard/core";

// Raw rows for the network leaderboard, read with the service role and kept
// in memory for 5 minutes: the ledger read pages through every row, so it
// must never run per request. The per-caller tokens are computed from the
// cached rows on each call (cheap).
const TTL_MS = 5 * 60_000;
let cache = { at: 0, rows: null, inflight: null };

/** Every row of a select, paged past PostgREST's 1,000-row cap. */
async function pages(build, pageSize = 1000) {
    const out = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await build().range(from, from + pageSize - 1);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
        if (!data || data.length < pageSize) return out;
    }
}

async function loadRows() {
    const db = getSupabaseServerClient();
    const optional = (p) => p.catch(() => []); // older databases: no referral program yet
    const [earnings, providers, links, identities, charges, commissions, attributions, people] = await Promise.all([
        pages(() => db.from("provider_earnings")
            .select("id, provider_id, kind, status, amount_usd, output_tokens, model_name, billed:metadata->>billed_user_id, earned_at, created_at")
            .order("id", { ascending: true })),
        pages(() => db.from("providers").select("id, node_id, public_key, is_public, archived_at, archived_is_public").order("id", { ascending: true })),
        pages(() => db.from("pubkey_links").select("pubkey, user_id, role").eq("role", "provider").order("pubkey", { ascending: true })),
        pages(() => db.from("coinpay_identities").select("user_id, coinpay_sub").order("user_id", { ascending: true })),
        pages(() => db.from("billing_ledger").select("id, user_id, amount_micro, created_at").eq("kind", "charge").order("id", { ascending: true })),
        optional(pages(() => db.from("referral_commissions").select("id, referrer_user_id, kind, status, amount_usd, earned_at").order("id", { ascending: true }))),
        optional(pages(() => db.from("referral_attributions").select("node_key, referrer_user_id, attributed_at").order("node_key", { ascending: true }))),
        optional(pages(() => db.from("referral_user_attributions").select("referred_user_id, referrer_user_id, attributed_at").order("referred_user_id", { ascending: true })))
    ]);
    return { earnings, providers, links, identities, charges, commissions, attributions, people };
}

async function rowsCached(now) {
    if (cache.rows && now - cache.at < TTL_MS) return cache.rows;
    if (!cache.inflight) {
        cache.inflight = loadRows()
            .then((rows) => {
                cache = { at: Date.now(), rows, inflight: null };
                return rows;
            })
            .catch((err) => {
                cache.inflight = null;
                throw err;
            });
    }
    // A stale copy beats waiting on a slow ledger read.
    return cache.rows ?? cache.inflight;
}

const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The leaderboard as one trusted caller sees it (tokens keyed with its bearer). Null when the ledger can't be read. */
export async function getNetworkLeaderboard(key, { now = Date.now() } = {}) {
    try {
        const rows = await rowsCached(now);
        return summariseLeaderboard(rows, { key, now, adminIds: list(process.env.INFERNET_ADMIN_USER_IDS) });
    } catch (err) {
        console.warn(`network leaderboard failed: ${err?.message ?? err}`);
        return null;
    }
}
