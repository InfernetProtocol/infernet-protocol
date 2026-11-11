import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { getBalance } from "@/lib/data/billing";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, billedSubjectFrom } from "@/lib/trusted-clients";
import { userIdForCoinpaySubject } from "@/lib/data/interactive-billing";
import { isAdminUser } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/billing/balance
 * Compute balance (prepaid + wallet), holds, earned_spendable (confirmed node
 * earnings you can spend on compute), per-source breakdown, funding order,
 * recent ledger rows.
 *
 * A trusted client of ours (lib/trusted-clients.js) may read the balance of
 * one of its own signed-in people by naming them in X-Infernet-Billed-Subject
 * — that is how c0mpute.com shows a balance in its own chat UI for a person
 * who authenticated there with CoinPay. Only a trusted key may do this; the
 * subject is resolved through coinpay_identities, so it reaches exactly the
 * account that subject signed in as here.
 */
export async function GET(request) {
    const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
    const subject = billedSubjectFrom(request, trusted);
    if (trusted && subject) {
        try {
            const userId = await userIdForCoinpaySubject(subject);
            if (!userId) {
                // Nobody has linked that CoinPay identity to an Infernet
                // account yet, so there is no balance to show. Not an error:
                // the client renders "no balance" and offers the sign-in.
                return ok({
                    linked: false,
                    subject,
                    total_spendable_usd: "0.000000",
                    note: "no Infernet account is linked to this CoinPay identity yet"
                });
            }
            // `admin: true` tells the client this account is unmetered, so
            // paid-only features (adult mode) are open even at a 0 balance.
            return ok({ linked: true, admin: isAdminUser({ id: userId }), ...(await getBalance({ id: userId })) });
        } catch (e) {
            return failFrom(e);
        }
    }
    if (trusted && !subject) {
        return fail(400, "name the person with X-Infernet-Billed-Subject (their CoinPay sub)");
    }

    const { user, error } = await requireCaller(request);
    if (error) return error;
    try { return ok({ linked: true, ...(await getBalance(user)) }); } catch (e) { return failFrom(e); }
}
