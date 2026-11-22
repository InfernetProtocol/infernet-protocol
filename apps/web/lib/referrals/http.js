import "server-only";
import { NextResponse } from "next/server";
import { requestUser, isFormPost } from "@/lib/auth/request-user";
import { isSameOriginRequest } from "@/lib/auth/admin";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, billedSubjectFrom } from "@/lib/trusted-clients";
import { userIdForCoinpaySubject } from "@/lib/data/interactive-billing";
import { publicOrigin } from "@/lib/credits/core";

/**
 * Who a referral API call is for:
 * - a trusted client (c0mpute.com, `ifc_` key) naming the person with
 *   X-Infernet-Billed-Subject (their CoinPay sub), or
 * - the signed-in caller: `infernet login` bearer, or the site cookie (only
 *   from our own pages).
 * Returns { userId, via } or { error: Response }.
 */
export async function referralCaller(request) {
    const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
    if (trusted) {
        const subject = billedSubjectFrom(request, trusted);
        if (!subject) return { error: jsonError(400, "name the person with X-Infernet-Billed-Subject (their CoinPay sub)") };
        const userId = await userIdForCoinpaySubject(subject);
        if (!userId) return { error: jsonError(404, "no Infernet account is linked to that CoinPay account yet") };
        return { userId, via: `client:${trusted.name}` };
    }
    const user = await requestUser(request);
    if (!user) return { error: jsonError(401, "sign in first (`infernet login`, or the site)") };
    if (user.via === "cookie" && request.method !== "GET" && !isSameOriginRequest(request.headers)) {
        return { error: jsonError(403, "cross-site request refused") };
    }
    return { userId: user.id, via: user.via };
}

export function jsonError(status, message, extra = {}) {
    return NextResponse.json({ error: message, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

export function jsonOk(data, status = 200) {
    return NextResponse.json({ data }, { status, headers: { "cache-control": "no-store" } });
}

/** A form post from /refer gets a redirect back with a notice; JSON gets JSON. */
export function respond(request, { data, error, status = 200, notice }) {
    if (isFormPost(request)) {
        const params = new URLSearchParams(error ? { error: error.message ?? String(error) } : { ok: notice ?? "saved" });
        return NextResponse.redirect(new URL(`/refer?${params}`, publicOrigin(request)), 303);
    }
    if (error) {
        const s = Number.isInteger(error.status) ? error.status : 500;
        if (s >= 500) console.error("[referrals]", error?.message ?? error);
        return jsonError(s, error.message ?? String(error), error.reason ? { reason: error.reason } : {});
    }
    return jsonOk(data, status);
}
