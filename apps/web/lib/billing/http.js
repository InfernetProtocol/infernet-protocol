import "server-only";
import { fail } from "@/lib/reservations/http";
import { billingCaller } from "@/lib/data/api-keys";
import { requestUser } from "@/lib/auth/request-user";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, billedSubjectFrom } from "@/lib/trusted-clients";
import { userIdForCoinpaySubject } from "@/lib/data/interactive-billing";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isPlaceholderEmail } from "@/lib/auth/coinpay-placeholder";

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

/**
 * A trusted client of ours (lib/trusted-clients.js) acting for one of its own
 * signed-in people, named by their CoinPay subject in X-Infernet-Billed-Subject.
 * Same trust model as GET /api/v1/billing/balance: only a registered trusted
 * key may name a subject, and the subject is resolved through
 * coinpay_identities, so it reaches exactly the account that subject is bound
 * to here and no other.
 *
 *   null                      not a trusted client: use requireCaller
 *   { error }                 trusted, but no subject (400 missing_subject) or
 *                             no linked account (404 subject_not_linked)
 *   { user, trusted, subject } the resolved account, `user.email` null
 */
export async function trustedSubjectCaller(request) {
    const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
    if (!trusted) return null;
    const subject = billedSubjectFrom(request, trusted);
    if (!subject) {
        return { error: fail(400, "missing_subject", { message: "name the person with X-Infernet-Billed-Subject (their CoinPay sub)" }) };
    }
    const userId = await userIdForCoinpaySubject(subject);
    if (!userId) {
        return {
            error: fail(404, "subject_not_linked", {
                message: "no Infernet account is linked to this CoinPay identity yet; POST /api/v1/coinpay/link-trusted, then retry"
            })
        };
    }
    return { user: { id: userId, email: null, via: `trusted:${trusted.name}` }, trusted, subject };
}

/**
 * The account's own auth email, or null. An account a first "Sign in with
 * CoinPay" created has a placeholder nobody receives mail at
 * (lib/auth/coinpay-placeholder.js): that counts as no address. Never throws.
 */
export async function accountEmail(userId) {
    try {
        const r = await getSupabaseServerClient().auth.admin.getUserById(userId);
        const email = r?.data?.user?.email;
        return typeof email === "string" && email && !isPlaceholderEmail(email) ? email : null;
    } catch {
        return null;
    }
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
