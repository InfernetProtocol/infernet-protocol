import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { encryptJSON } from "@/lib/encrypt";
import { chargeUsage, USAGE_SOURCE } from "@/lib/billing/usage";
import { c0mputeProviderId } from "@/lib/data/chat-c0mpute";
import {
    getInteractiveConfig,
    creditProvidersFromCharge,
    userIdForCoinpaySubject
} from "@/lib/data/interactive-billing";

/**
 * Usage charges: the DB half of lib/billing/usage.js.
 *
 * Every write goes through what chat billing already uses: the node's
 * providers row (c0mputeProviderId), the billing ledger
 * (billing_charge_exact, which charges through billing_charge_interactive)
 * and creditProvidersFromCharge for the node's 'paid' row. The house fee and
 * the referral commission are posted by the provider_earnings triggers, as
 * for any other credit.
 */

function fromDb(error, what) {
    return Object.assign(new Error(`${what}: ${error?.message ?? error}`), { status: 500 });
}

export function supabaseUsageStore(supabase) {
    return {
        providerId: (peerId) => c0mputeProviderId(supabase, peerId),

        async charge({ userId, idem, costMicro, allowEarned, jobId }) {
            const { data, error } = await supabase.rpc("billing_charge_exact", {
                p_user_id: userId,
                p_idem: idem,
                p_cost_micro: costMicro,
                p_allow_earned: allowEarned,
                p_job_id: jobId
            });
            if (error) throw fromDb(error, "usage charge failed");
            return data ?? {};
        },

        async job(jobId) {
            const { data, error } = await supabase
                .from("jobs")
                .select("id, provider_id, model_name, billed_user_id")
                .eq("id", jobId)
                .maybeSingle();
            if (error) throw fromDb(error, "could not read the usage job");
            return data ?? null;
        },

        async ensureJob(row) {
            const { error } = await supabase
                .from("jobs")
                .upsert({ ...row, input_spec: encryptJSON(row.input_spec) }, { onConflict: "id", ignoreDuplicates: true });
            if (error) throw fromDb(error, "could not record the usage job");
        },

        async credit({ job, chargeMicro, feePct, kind }) {
            const out = await creditProvidersFromCharge({
                supabase,
                job,
                chargeMicro,
                outputTokens: 0,
                feePct,
                source: USAGE_SOURCE,
                extra: { usage_kind: kind }
            });
            if (out?.error) throw fromDb(out.error, "could not credit the node");
        },

        async earning(jobId, providerId) {
            const { data, error } = await supabase
                .from("provider_earnings")
                .select("id, gross_usd, fee_usd, amount_usd, status")
                .eq("job_id", jobId)
                .eq("provider_id", providerId)
                .maybeSingle();
            if (error) throw fromDb(error, "could not read the node credit");
            return data ?? null;
        }
    };
}

/**
 * Charge a usage amount to the account behind a CoinPay subject, for a
 * trusted client. Returns the response body; throws with `.status` on a
 * conflict or a failure (see chargeUsage).
 */
export async function chargeUsageForSubject({ subject, client, input }) {
    const userId = await userIdForCoinpaySubject(subject);
    if (!userId) {
        // Nobody has linked that CoinPay identity yet (link-trusted does it at
        // sign-in), so there is no balance to charge.
        return { charged: false, reason: "no_account", balance_usd: 0 };
    }
    const config = await getInteractiveConfig();
    return chargeUsage({
        input,
        userId,
        client,
        store: supabaseUsageStore(getSupabaseServerClient()),
        feePct: config.house_fee_pct,
        allowEarned: config.spend_earned
    });
}
