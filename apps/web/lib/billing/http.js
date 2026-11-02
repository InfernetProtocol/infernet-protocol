import "server-only";
import { fail } from "@/lib/reservations/http";
import { billingCaller } from "@/lib/data/api-keys";
import { requestUser } from "@/lib/auth/request-user";

/**
 * Auth for /api/v1/billing/* and /api/v1/batches/*: an ik_live_ API key as
 * Bearer, or the signed-in user (`infernet login` bearer / site cookie).
 * Key management (/api/v1/keys) takes the signed-in user only: a key never
 * mints or revokes keys.
 */
export async function requireCaller(request) {
    const user = await billingCaller(request);
    return user ? { user } : { error: fail(401, "authorization required: Authorization: Bearer ik_live_... (create one with `infernet keys create`), or sign in") };
}

export async function requireSignedIn(request) {
    const user = await requestUser(request);
    return user ? { user } : { error: fail(401, "sign in first (`infernet login`, or the site) to manage API keys") };
}

/** Route error -> JSON, with any extra fields the error carries. */
export function failFrom(e, tag = "billing") {
    const status = Number.isInteger(e?.status) ? e.status : 500;
    if (status >= 500) console.error(`[${tag}]`, e?.message ?? e);
    const extra = {};
    for (const k of ["details", "sellable", "batch_id", "total_max_cost_usd"]) if (e?.[k] !== undefined) extra[k] = e[k];
    return fail(status, e?.message ?? String(e), extra);
}
