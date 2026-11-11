import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { microToUsd } from "@/lib/billing/core";
import { isAdminUser } from "@/lib/auth/admin";
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
        // Admins (INFERNET_ADMIN_USER_IDS) are unmetered: never charged, never
        // drawing the free allowance, and treated as paid for adult mode.
        if (userId && isAdminUser({ id: userId })) {
            return { mode: "admin", reason: "admin", spendable_micro: 0, spendable_usd: "0.000000", config };
        }
        if (!config.enabled || !userId) return { ...free(config.enabled ? "anonymous" : "metering_off"), config };

        const { getInferencePricing, fundingPreview } = await import("@/lib/data/billing");
        const [pricing, funding] = await Promise.all([getInferencePricing(), fundingPreview(userId)]);
        const { getPriceDefaults } = await import("@/lib/data/operator-prices");
        const defaults = await getPriceDefaults();
        const decision = interactiveModeFor({ model, pricing, config, funding, defaults, signedIn });
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
        // The price of the node that actually served it: operator price if it
        // has one (clamped to the house band), else the house table, else the
        // house default. Never free - that is what the default is for.
        const { priceForJob } = await import("@/lib/data/operator-prices");
        const effective = await priceForJob({ providerId: job.provider_id ?? null, model, pricing });
        const quote = priceInteractive({
            model,
            pricing,
            price: effective,
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
 * Pay the serving node(s) out of what the customer was actually charged.
 *
 * This is the half that keeps interactive billing solvent. A billed
 * interactive job has payment_offer 0 and no batch item, so the ordinary
 * completion path would credit it the FREE-TIER SUBSIDY rate
 * (subsidy_per_1k_output_usd, $0.01 per 1k output tokens = $10 per 1M) while
 * the customer paid the per-model table price ($0.20 per 1M output on
 * qwen2.5:7b). The house would lose roughly fifty times the sale price on
 * every chat. So a billed job is credited like a paid batch item instead: the
 * provider takes its share of the charge and the house keeps house_fee_pct.
 *
 * Idempotent on (job_id, provider_id), the same constraint the rest of the
 * ledger relies on, so a retried completion cannot pay twice. Never throws.
 */
export async function creditProvidersFromCharge({
    supabase,
    job,
    chargeMicro,
    outputTokens,
    shares = null,
    feePct,
    price = null,
    source = "interactive"
}) {
    try {
        const { providerSplitMicro, microToUsd: toUsd } = await import("@/lib/billing/core");
        const parts = (shares ?? [{ provider_id: job.provider_id, share: 1, role: "single" }])
            .filter((x) => x?.provider_id);
        if (parts.length === 0 || !(chargeMicro > 0)) return { credited: 0 };

        const now = new Date().toISOString();
        const rows = parts.map((part) => {
            const shareMicro = Math.floor(chargeMicro * (Number(part.share) || 0));
            const { feeMicro, providerMicro } = providerSplitMicro(shareMicro, feePct);
            return {
                job_id: job.id,
                provider_id: part.provider_id,
                kind: "paid",
                role: part.role ?? "single",
                share: Number(part.share) || 0,
                output_tokens: Math.round((Number(outputTokens) || 0) * (Number(part.share) || 0)),
                tokens_estimated: true,
                held_reason: null,
                rate_per_1k_usd: null,
                gross_usd: toUsd(shareMicro),
                fee_usd: toUsd(feeMicro),
                amount_usd: toUsd(providerMicro),
                coin: null,
                status: "confirmed",
                model_name: job.model_name ?? null,
                confirmed_at: now,
                earned_at: now,
                metadata: {
                    source,
                    house_fee_pct: Number(feePct) || 0,
                    charge_micro: shareMicro,
                    billed_user_id: job.billed_user_id ?? null,
                    ...(price
                        ? {
                            price_source: price.source,
                            input_per_m_usd: price.input_per_m_usd,
                            output_per_m_usd: price.output_per_m_usd
                        }
                        : {})
                }
            };
        });

        const client = supabase ?? db();
        const { error } = await client
            .from("provider_earnings")
            .upsert(rows, { onConflict: "job_id,provider_id", ignoreDuplicates: true });
        if (error) {
            console.warn(`[interactive-billing] provider credit for job ${job.id} failed: ${error.message}`);
            return { credited: 0, error: error.message };
        }
        return { credited: rows.length };
    } catch (err) {
        console.warn(`[interactive-billing] provider credit failed: ${err?.message ?? err}`);
        return { credited: 0, error: String(err?.message ?? err) };
    }
}

/**
 * Charge the buyer and pay the provider(s) from that charge, in one step.
 *
 * Returns { billed: true } when the job was paid for from a balance, so the
 * caller must NOT also credit the free-tier subsidy. { billed: false } means
 * nothing was charged (metering off, free tier, unpriced model, empty
 * balance) and the ordinary subsidy path still applies.
 */
/**
 * Charge one generated image (a c0mpute diffusion.txt2img job) a flat price.
 *
 * Same ledger and the same idempotency as chat: job:<c0mpute job id>:charge.
 * The job id is the UUID the c0mpute gateway returns. Never throws: the image
 * has already been made and sent.
 */
export async function chargeImageJob({ userId, jobId, costMicro }) {
    if (!userId || !jobId) return { charged: false, reason: "no_buyer" };
    if (!(costMicro > 0)) return { charged: false, reason: "nothing_to_charge" };
    try {
        const config = await getInteractiveConfig();
        if (!config.enabled) return { charged: false, reason: "metering_off" };
        const { data, error } = await db().rpc("billing_charge_interactive", {
            p_user_id: userId,
            p_idem: chargeIdemKey(jobId),
            p_cost_micro: Math.floor(costMicro),
            p_allow_earned: config.spend_earned,
            p_job_id: jobId
        });
        if (error) throw error;
        const out = data ?? {};
        return {
            charged: Boolean(out.charged),
            reason: out.reason ?? null,
            charged_micro: Number(out.charged_micro ?? 0),
            charged_usd: microToUsd(out.charged_micro ?? 0)
        };
    } catch (err) {
        console.warn(`[interactive-billing] image charge failed for job ${jobId}: ${err?.message ?? err}`);
        return { charged: false, reason: String(err?.message ?? err) };
    }
}

export async function settleInteractiveJob({ supabase, job, result, shares = null, outputTokens = null }) {
    if (!job?.billed_user_id) return { billed: false, reason: "no_buyer" };
    const charge = await chargeInteractiveJob({ job, result, outputTokens });
    // A retry finds the charge already recorded; the job was still balance-paid,
    // so the subsidy must stay skipped.
    const billed = charge.charged || charge.reason === "already_charged";
    if (!billed) return { billed: false, reason: charge.reason, charge };

    if (charge.charged_micro > 0) {
        const config = await getInteractiveConfig();
        await creditProvidersFromCharge({
            supabase,
            job,
            chargeMicro: charge.charged_micro,
            outputTokens: charge.quote?.output_tokens ?? outputTokens ?? 0,
            shares,
            feePct: config.house_fee_pct,
            price: charge.quote?.price ?? null
        });
    }
    return { billed: true, charge };
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
