import { ok } from "@/lib/reservations/http";
import { requireSignedIn, failFrom } from "@/lib/billing/http";
import { createApiKey, listApiKeys } from "@/lib/data/api-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/keys            your API keys (prefixes only)
 * POST /api/v1/keys { name? }  a new ik_live_ key, shown once
 * Signed-in user only (site cookie or `infernet login` bearer).
 */
export async function GET(request) {
    const { user, error } = await requireSignedIn(request);
    if (error) return error;
    try { return ok(await listApiKeys(user)); } catch (e) { return failFrom(e, "keys"); }
}

export async function POST(request) {
    const { user, error } = await requireSignedIn(request);
    if (error) return error;
    let body = {};
    try { body = (await request.json()) ?? {}; } catch { /* no body */ }
    try { return ok(await createApiKey(user, { name: body.name }), 201); } catch (e) { return failFrom(e, "keys"); }
}
