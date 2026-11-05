import { ok, fail } from "@/lib/reservations/http";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor } from "@/lib/trusted-clients";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { resolveCoinpayUser, supabaseCoinpayStore } from "@/lib/auth/coinpay-signin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/coinpay/link-trusted — give one of our own apps' CoinPay users
 * an Infernet account, so their compute balance can be billed here.
 *
 *   Authorization: Bearer ifc_...        (a trusted client, lib/trusted-clients.js)
 *   { sub, email?, name? }
 *   → { user_id, action: "login" | "created" }
 *
 * Why this exists: c0mpute.com signs people in with CoinPay and sends their
 * inference here under its own trusted key. Billing resolves the person
 * through coinpay_identities, but that row only existed if they had ALSO
 * signed in to infernetprotocol.com with the same CoinPay account. In
 * practice almost nobody had, so c0mpute's whole user base was unbillable and
 * its "top up" link pointed at a site they had no account on.
 *
 * The trust boundary: the calling app verified this `sub` itself through
 * CoinPay's OAuth and userinfo, exactly as our own callback does, and it holds
 * a trusted key. We accept its word on the sub and nothing else — the email
 * and name ride along as unverified contact info only, never as identity
 * (CoinPay does not verify emails; binding on one would be a takeover path).
 *
 * Idempotent: resolveCoinpayUser returns the existing account for a sub that
 * is already bound, and only creates one on a first sight.
 */
export async function POST(request) {
    const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
    if (!trusted) {
        return fail(401, "a trusted client key is required (Authorization: Bearer ifc_...)");
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return fail(400, "invalid JSON body");
    }

    const sub = typeof body?.sub === "string" ? body.sub.trim() : "";
    if (!sub || sub.length > 200) return fail(400, "sub is required (the person's CoinPay subject)");

    const email = typeof body?.email === "string" && body.email.length <= 320 ? body.email : null;
    const name = typeof body?.name === "string" && body.name.length <= 200 ? body.name : null;

    try {
        const store = supabaseCoinpayStore(getSupabaseServerClient());
        const r = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub, email, name } }, store);
        if (!r.ok) return fail(409, r.error, { code: r.code });
        return ok({ user_id: r.userId, action: r.action, client: trusted.name });
    } catch (e) {
        console.error("[coinpay link-trusted]", e?.message ?? e);
        return fail(500, "could not link that CoinPay identity");
    }
}
