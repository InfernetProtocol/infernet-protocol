import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Durable provider kill switch. providers.disabled_at is set by an admin and
 * only an admin clears it: heartbeats and re-registers keep such a node at
 * status 'disabled', so chat routing, order matching and pickNode (which
 * all want status 'available') never see it, and it earns nothing.
 */

function withStatus(message, status) {
    return Object.assign(new Error(message), { status });
}

const COLUMNS = "id, node_id, name, status, disabled_at, disabled_reason, disabled_by";

export async function setProviderDisabled(id, { disabled, reason = null, actor = null } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ""))) throw withStatus("provider id must be a uuid", 400);
    const supabase = getSupabaseServerClient();
    const { data: row, error } = await supabase.from("providers").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw withStatus(error.message, 500);
    if (!row) throw withStatus("provider not found", 404);
    const now = new Date().toISOString();
    const patch = disabled
        ? {
            disabled_at: row.disabled_at ?? now,
            disabled_reason: reason ? String(reason).slice(0, 500) : row.disabled_reason ?? null,
            disabled_by: actor ?? null,
            // Archived stays archived; anything else leaves routing now.
            ...(row.status === "archived" ? {} : { status: "disabled" })
        }
        // Back to 'offline': the next heartbeat makes it available again.
        : { disabled_at: null, disabled_reason: null, disabled_by: null, ...(row.status === "disabled" ? { status: "offline" } : {}) };
    const { data, error: upErr } = await supabase.from("providers").update(patch).eq("id", id).select(COLUMNS).single();
    if (upErr) throw withStatus(upErr.message, 500);
    return data;
}

export async function listDisabledProviders() {
    const { data, error } = await getSupabaseServerClient().from("providers").select(COLUMNS)
        .not("disabled_at", "is", null).order("disabled_at", { ascending: false });
    if (error) throw withStatus(error.message, 500);
    return data ?? [];
}
