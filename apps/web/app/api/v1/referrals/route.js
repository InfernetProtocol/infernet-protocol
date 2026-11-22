import { referralCaller, respond } from "@/lib/referrals/http";
import { getReferralOverview, getOrCreateCode } from "@/lib/data/referrals";
import { referralLinks } from "@/lib/referrals/core";
import { publicOrigin } from "@/lib/credits/core";
import { getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function withLinks(request, o) {
    return o?.has_code ? { ...o, ...referralLinks(o.code, { infernetOrigin: publicOrigin(request) }) } : o;
}

/**
 * GET  /api/v1/referrals  -> your referral code, term, referred nodes,
 *                            commissions (pending / confirmed / paid), payouts
 * POST /api/v1/referrals  -> create your code (idempotent; the commission term
 *                            is assigned once, here)
 * Auth: `infernet login` bearer, the site cookie, or a trusted client with
 * X-Infernet-Billed-Subject.
 */
export async function GET(request) {
    const who = await referralCaller(request);
    if (who.error) return who.error;
    try {
        return respond(request, { data: withLinks(request, await getReferralOverview(who.userId)) });
    } catch (error) {
        return respond(request, { error });
    }
}

export async function POST(request) {
    const who = await referralCaller(request);
    if (who.error) return who.error;
    try {
        // Only a hash of the /24 is kept, for the self-referral check.
        const ip = who.via.startsWith("client:") ? request.headers.get("x-infernet-client-ip") : getClientIp(request);
        const { created } = await getOrCreateCode(who.userId, { ip });
        const data = withLinks(request, await getReferralOverview(who.userId));
        return respond(request, { data: { ...data, created }, status: created ? 201 : 200, notice: "created" });
    } catch (error) {
        return respond(request, { error });
    }
}
