import { issueKey, listKeys } from "@/lib/data/reservations";
import { loadForReader, ok, fail, guard } from "@/lib/reservations/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 *   GET  /api/v1/reservations/:id/keys   list keys (prefix only)
 *   POST /api/v1/reservations/:id/keys   issue a key { label? } -> { key } shown once
 *
 * Admin or the reservation's buyer token. Keys are what the reseller hands
 * to its own customers. They work against
 * /v1/chat/completions and /v1/models with Authorization: Bearer <key>.
 */
export async function GET(request, { params }) {
    const { id } = await params;
    return guard(async () => {
        const r = await loadForReader(request, id);
        if (r.error) return r.error;
        return ok(await listKeys(id));
    });
}

export async function POST(request, { params }) {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    return guard(async () => {
        const r = await loadForReader(request, id);
        if (r.error) return r.error;
        const res = r.res;
        if (res.status === "cancelled") return fail(409, "reservation is cancelled");
        const label = typeof body?.label === "string" ? body.label.slice(0, 120) : null;
        return ok(await issueKey(id, { label }), 201);
    });
}
