import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { foldJobsByNode } from "@/lib/jobs-by-node";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 10_000;

/**
 * Every Infernet job in the last 24h, grouped by the node that ran it: the
 * c0mpute workers chat is routed to first, Infernet's provider daemons, and
 * the hosted fallback. Free and billed jobs both count. For /status.
 * Never throws: an empty table beats a broken status page.
 */
export async function getJobsByNode24h({ now = Date.now() } = {}) {
  try {
    const supabase = getSupabaseServerClient();
    const since = new Date(now - DAY_MS).toISOString();
    const [{ data: jobs }, { data: earnings }] = await Promise.all([
      supabase
        .from("jobs")
        .select("provider_id, status, billed_user_id, assigned_at, created_at, completed_at, model_name")
        .eq("type", "chat")
        .gte("created_at", since)
        .limit(MAX_ROWS),
      supabase
        .from("provider_earnings")
        .select("provider_id, amount_usd")
        .gte("created_at", since)
        .limit(MAX_ROWS)
    ]);
    const ids = [...new Set((jobs ?? []).map((j) => j.provider_id).filter(Boolean))];
    const { data: providers } = ids.length
      ? await supabase.from("providers").select("id, name, node_id").in("id", ids)
      : { data: [] };
    return foldJobsByNode({ jobs: jobs ?? [], providers: providers ?? [], earnings: earnings ?? [] });
  } catch (err) {
    console.warn(`[status] jobs by node failed: ${err?.message ?? err}`);
    return [];
  }
}
