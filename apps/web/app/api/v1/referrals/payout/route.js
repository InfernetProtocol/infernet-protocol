import { referralCaller, respond } from "@/lib/referrals/http";
import { readBody } from "@/lib/auth/request-user";
import { requestReferralPayout } from "@/lib/data/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/referrals/payout { amount_usd? }  (empty = everything available)
 * Withdraws confirmed referral commissions through the node payout path: the
 * same minimum, the same auto-approve cap, sent by CoinPay.
 */
export async function POST(request) {
    const who = await referralCaller(request);
    if (who.error) return who.error;
    const body = await readBody(request);
    const raw = body.amount_usd ?? body.amount;
    const amountUsd = raw === undefined || raw === null || String(raw).trim() === "" ? null : Number(raw);
    try {
        const via = who.via.startsWith("client:") ? who.via.slice(0, 40) : who.via === "bearer" ? "cli" : "dashboard";
        const out = await requestReferralPayout({ userId: who.userId, amountUsd, via });
        return respond(request, { data: out, status: 201, notice: out.request?.status === "sent" ? "payout_sent" : "payout_requested" });
    } catch (error) {
        return respond(request, { error });
    }
}
