import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { getBlocklists, updateBlocklists } from "@/lib/data/blocklists";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/admin/blocklists → { model_denylist: { models }, order_blocklist: { emails, payers } }
 * POST /api/v1/admin/blocklists  { model_denylist?: { models: [...] }, order_blocklist?: { emails: [...], payers: [...] } }
 * Each list given is replaced whole. Emails may be "@domain.tld" to block a domain.
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    return ok(await getBlocklists());
}

export async function POST(request) {
    const { actor, error } = await requireAdmin(request);
    if (error) return error;
    const body = await request.json().catch(() => ({}));
    try {
        return ok(await updateBlocklists(body, { actor }));
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
