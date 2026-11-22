import { referralCaller, respond } from "@/lib/referrals/http";
import { readBody } from "@/lib/auth/request-user";
import { setReferralPayoutAddress } from "@/lib/data/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST|PUT /api/v1/referrals/address { coin, network, address }: where commission payouts go. */
async function handle(request) {
    const who = await referralCaller(request);
    if (who.error) return who.error;
    const body = await readBody(request);
    try {
        const row = await setReferralPayoutAddress(who.userId, body);
        return respond(request, {
            data: { coin: row.payout_coin, network: row.payout_network, address: row.payout_address },
            notice: "address_saved"
        });
    } catch (error) {
        return respond(request, { error });
    }
}

export const POST = handle;
export const PUT = handle;
