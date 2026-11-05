import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { microToUsd } from "@/lib/billing/core";
import {
    INTERACTIVE_SETTINGS_KEY,
    resolveInteractiveConfig,
    interactiveModeFor,
    priceInteractive,
    chargeIdemKey,
    spendableMicro
} from "@/lib/billing/interactive";

/**
 * Pay-as-you-go for interactive inference: the DB half.
 *
 * Reuses everything paid batches already use — billing_accounts, the
 * billing_ledger, the per-model price table, and 'earned' node revenue as a
 * funding source. The only new SQL is billing_charge_interactive (charge one
 * finished request, once) and billing_fund_from_earned (move earnings into
 * the compute balance on their own).
 *
 * Nothing here ever throws into an inference path: a billing outage must
 * degrade to the free tier, not take chat down.
 */

function db(supabase) {
    return supabase ?? getSupabaseServerClient();
}

function withStatus(message, status, extra = {}) {
    return Object.assign(new Error(message), { status, ...extra });
}

export async function getInteractiveConfig(supabase) {
    let settings = null;
    try {
        const { data } = await db(supabase)
            .from("settings")
            .select("value")
            .eq("key", INTERACTIVE_SETTINGS_KEY)
            .maybeSingle();
        settings = data?.value ?? null;
    } catch {
        /* defaults + env */
    }
    return resolveInteractiveConfig({ env: process.env, settings });
}

export async function updateInteractiveConfig(patch, { actor } = {}) {
    const current = await getInteractiveConfig();
    const next = resolveInteractiveConfig({ env: process.env, settings: { ...current, ...(patch ?? {}) } });
    const { error } = await db()
        .from("settings")
        .upsert(
            { key: INTERACTIVE_SETTINGS_KEY, value: { ...next, updated_by: actor ?? null }, updated_at: new Date().toISOString() },
            { onConflict: "key" }
        );
    if (error) throw withStatus(error.message, 500);
    return next;
}

/**
 * Decide how an interactive request is paid for, before it runs.
 *
 * Never throws. If the lookup fails the caller is served on the free tier,
 * which costs the house a fraction of a cent and keeps inference up.
 */
export async function authorizeInteractive({ userId, model, signedIn = Boolean(userId) }) {
    const free = (reason) => ({ mode: "free", reason, spendable_micro: 0, spendable_usd: "0.000000" });
    try {
        const config = await getInteractiveConfig();
        if (!config.enabled || !userId) return { ...free(config.enabled ? "anonymous" : "metering_off"), config };

        const { getInferencePricing, fundingPreview } = await import("@/lib/data/billing");
        const [pricing, funding] = await Promise.all([getInferencePricing(), fundingPreview(userId)]);
        const decision = interactiveModeFor({ model, pricing, config, funding, signedIn });
        const spendable = spendableMicro({ funding, config });
        return {
            ...decision,
            spendable_micro: spendable,
            spendable_usd: microToUsd(spendable),
            config,
            pricing
        };
    } catch (err) {
        console.warn(`[interactive-billing] authorize failed, serving free: ${err?.message ?? err}`);
        return { ...free("degraded"), degraded: true };
    }
}

/**
 * Charge a finished interactive job to its buyer.
 *
 * Idempotent: the ledger key is job:<id>:charge and billing_ledger.idem_key is
 * unique, so a retried completion or two completion paths racing the same job
 * charge once. Never throws — the answer has already been streamed to the
 * caller and the provider has already done the work.
 */
export async function chargeInteractiveJob({ job, result, messages = null, inputTokens = null, outputTokens = null }) {
    const userId = job?.billed_user_id ?? null;
    if (!userId || !job?.id) return { charged: false, reason: "no_buyer" };
    try {
        const config = await getInteractiveConfig();
        if (!config.enabled) return { charged: false, reason: "metering_off" };

        const { getInferencePricing } = await import("@/lib/data/billing");
        const pricing = await getInferencePricing();
        const model = job.model_name ?? null;
        const spec = job.input_spec ?? {};
        const quote = priceInteractive({
            model,
            pricing,
            messages: messages ?? spec.messages ?? [],
            inputTokens: inputTokens ?? spec.input_tokens ?? null,
            result: outputTokens == null ? result : { text: "" },
            maxTokens: Number.isInteger(spec.max_tokens) ? spec.max_tokens : null
        });
        // An explicit output-token count from the server's own estimate (the
        // streaming paths know the text they emitted) beats re-deriving it.
        if (outputTokens != null && quote.priced) {
            const { costMicro } = await import("@/lib/billing/core");
            quote.output_tokens = Math.max(0, Math.floor(outputTokens));
            quote.cost_micro = costMicro({
                inputTokens: quote.input_tokens,
                outputTokens: quote.output_tokens,
                input_micro_per_m: quote.input_micro_per_m,
                output_micro_per_m: quote.output_micro_per_m
            });
        }
        if (!quote.priced) return { charged: false, reason: "unpriced_model", model };
        if (quote.cost_micro <= 0) return { charged: false, reason: "nothing_to_charge", quote };

        const { data, error } = await db().rpc("billing_charge_interactive", {
            p_user_id: userId,
            p_idem: chargeIdemKey(job.id),
            p_cost_micro: quote.cost_micro,
            p_allow_earned: config.spend_earned,
            p_job_id: job.id
        });
        if (error) throw error;

        const out = data ?? {};
        return {
            charged: Boolean(out.charged),
            reason: out.reason ?? null,
            charged_micro: Number(out.charged_micro ?? 0),
            charged_usd: microToUsd(out.charged_micro ?? 0),
            shortfall_micro: Number(out.shortfall_micro ?? 0),
            earned_pulled_micro: Number(out.earned_pulled_micro ?? 0),
            available_micro: Number(out.available_micro ?? 0),
            available_usd: microToUsd(out.available_micro ?? 0),
            quote
        };
    } catch (err) {
        console.warn(`[interactive-billing] charge failed for job ${job?.id}: ${err?.message ?? err}`);
        return { charged: false, reason: String(err?.message ?? err) };
    }
}

/**
 * Move confirmed node earnings into the compute balance, on their own.
 *
 * Before this, earnings could only reach the balance as part of submitting a
 * batch. A provider who wanted to spend what they earned on anything else had
 * no way to do it.
 *
 * One way, and the invariant that makes it safe is already in the database:
 * the transfer writes a negative provider_earnings row of kind
 * 'spent_on_compute', so provider_available_usd drops and
 * payout_requests_guard refuses to pay out the same dollars.
 */
export async function fundFromEarnings({ userId, amountUsd = null }) {
    if (!userId) throw withStatus("sign in required", 401);
    let amountMicro = null;
    if (amountUsd != null && amountUsd !== "" && amountUsd !== "all") {
        const { usdToMicro } = await import("@/lib/billing/core");
        amountMicro = usdToMicro(amountUsd);
        if (amountMicro === null || amountMicro <= 0) {
            throw withStatus("amount must be a positive USD value with at most 6 decimals", 400);
        }
    }
    const { data, error } = await db().rpc("billing_fund_from_earned", {
        p_user_id: userId,
        p_amount_micro: amountMicro
    });
    if (error) throw withStatus(error.message, 500);
    const out = data ?? {};
    const moved = Number(out.moved_micro ?? 0);
    if (moved <= 0) {
        throw withStatus(
            out.reason === "nothing_confirmed"
                ? "no confirmed node earnings to move yet"
                : "nothing was moved",
            400
        );
    }
    return {
        moved_usd: microToUsd(moved),
        moved_micro: moved,
        balance_usd: microToUsd(out.balance_micro ?? 0),
        available_usd: microToUsd(out.available_micro ?? 0),
        note: "Moved out of withdrawable earnings and into the compute balance; it can no longer be paid out."
    };
}

/**
 * The Infernet account a CoinPay subject belongs to, or null.
 *
 * coinpay_identities is written by "Sign in with CoinPay" and keyed on the
 * verified CoinPay `sub` (never the email, which CoinPay does not verify -
 * binding on it would be an account-takeover path). A trusted client naming a
 * subject therefore reaches exactly the account that subject already signed in
 * as here, and no other.
 */
export async function userIdForCoinpaySubject(sub) {
    if (typeof sub !== "string" || !sub) return null;
    try {
        const { data, error } = await db()
            .from("coinpay_identities")
            .select("user_id")
            .eq("coinpay_sub", sub)
            .maybeSingle();
        if (error) return null;
        return data?.user_id ?? null;
    } catch {
        return null;
    }
}

/**
 * Who pays for this request: the signed-in account (session, `infernet login`
 * bearer, or an ik_live_ API key), or - for a trusted client of ours - the
 * person it names with X-Infernet-Billed-Subject.
 *
 * Never throws: an unresolvable caller is anonymous, which is the free tier.
 */
export async function resolveBillingCaller(request, { trusted = null } = {}) {
    try {
        const { billingCaller } = await import("@/lib/data/api-keys");
        const direct = await billingCaller(request);
        if (direct?.id) return { userId: direct.id, via: "account" };
    } catch {
        /* no account on this request; try the trusted path */
    }
    if (trusted) {
        const { billedSubjectFrom } = await import("@/lib/trusted-clients");
        const sub = billedSubjectFrom(request, trusted);
        if (sub) {
            const userId = await userIdForCoinpaySubject(sub);
            if (userId) return { userId, via: `trusted:${trusted.name}` };
            // The client named someone with no Infernet account yet. Serve them
            // on the free tier rather than refusing: they have no balance to
            // spend either way, and a 402 here would break their chat.
            return { userId: null, via: "trusted_unlinked", subject: sub };
        }
    }
    return { userId: null, via: "anonymous" };
}
