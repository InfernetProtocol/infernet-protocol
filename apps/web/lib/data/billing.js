import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { cleanPricePair } from "@/lib/billing/operator-prices";
import { resolveInferencePricing, validatePricingPatch, microToUsd, parseTopupAmount, cleanFundingOrder, FUNDING_SOURCES, DEFAULT_FUNDING_ORDER } from "@/lib/billing/core";
import { verifyOrderAtCoinpayDetail } from "@/lib/data/reservation-orders";
import { createCheckout } from "@infernetprotocol/payments";
import { siteUrl } from "@/lib/reservations/order-payment";

/**
 * Prepaid balance for paid batch inference (DB half; math in lib/billing/core.js,
 * invariants in the SQL functions of 20261102020000_paid_batch_inference.sql).
 *
 * A top-up is a CoinPay checkout. It is credited ONLY after CoinPay itself
 * confirms the full amount was collected (verifyOrderAtCoinpayDetail, the
 * same check self-serve orders use), from the webhook or the buyer's poll,
 * and exactly once: billing_credit_topup flips the row off awaiting_payment
 * under a lock and the ledger key topup:<id> is unique.
 */

const SETTINGS_KEY = "inference_pricing";
const TOPUP_COLUMNS = "id, user_id, user_email, amount_usd, amount_micro, status, payment_ref, checkout_url, tx_hash, created_at, paid_at";

function db(supabase) {
    return supabase ?? getSupabaseServerClient();
}

function withStatus(message, status, extra = {}) {
    return Object.assign(new Error(message), { status, ...extra });
}

export async function getInferencePricing(supabase) {
    let settings = null;
    try {
        const { data } = await db(supabase).from("settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
        settings = data?.value ?? null;
    } catch {
        /* defaults + env */
    }
    return resolveInferencePricing({ settings });
}

export async function updateInferencePricing(patch, { actor } = {}) {
    const current = await getInferencePricing();
    const v = validatePricingPatch(patch, current);
    if (!v.ok) throw withStatus(`invalid pricing: ${v.errors.join("; ")}`, 400);

    // resolveInferencePricing only returns the keys IT knows, so writing
    // v.value alone silently dropped everything else on the row - which is how
    // default_model_price and the operator price band disappeared the first
    // time they were set. Merge over the row as it is stored, so a key this
    // function does not model survives being edited.
    //
    // Those extra keys are still validated: on the way in by
    // validateExtraPricing below, and again on every read by
    // resolvePriceDefaults, which falls back rather than trusting a bad value.
    let stored = {};
    try {
        const { data } = await db().from("settings").select("value").eq("key", SETTINGS_KEY).maybeSingle();
        stored = data?.value && typeof data.value === "object" && !Array.isArray(data.value) ? data.value : {};
    } catch {
        /* first write */
    }

    const extra = validateExtraPricing(patch);
    if (!extra.ok) throw withStatus(`invalid pricing: ${extra.errors.join("; ")}`, 400);

    const value = { ...stored, ...v.value, ...extra.value, updated_by: actor ?? null };
    const { error } = await db().from("settings").upsert(
        { key: SETTINGS_KEY, value, updated_at: new Date().toISOString() },
        { onConflict: "key" }
    );
    if (error) throw withStatus(error.message, 500);
    return value;
}

/**
 * The pricing keys resolveInferencePricing does not model: the default price
 * for an unpriced model, and the band an operator's own price must sit in
 * (lib/billing/operator-prices.js). Only keys actually present in the patch
 * are returned, so a partial update never clears the others.
 */
function validateExtraPricing(patch) {
    const p = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
    const errors = [];
    const out = {};

    if ("default_model_price" in p) {
        const pair = cleanPricePair(p.default_model_price);
        if (!pair) errors.push("default_model_price must be { input_per_m_usd, output_per_m_usd }, each 0-1000 with at most 6 decimals");
        else out.default_model_price = pair;
    }
    if ("operator_pricing_enabled" in p) {
        if (typeof p.operator_pricing_enabled !== "boolean") errors.push("operator_pricing_enabled must be true or false");
        else out.operator_pricing_enabled = p.operator_pricing_enabled;
    }
    for (const key of ["operator_price_min_per_m_usd", "operator_price_max_per_m_usd"]) {
        if (!(key in p)) continue;
        const n = typeof p[key] === "string" ? Number.parseFloat(p[key]) : p[key];
        if (!Number.isFinite(n) || n < 0 || n > 1000) errors.push(`${key} must be a number between 0 and 1000`);
        else out[key] = Math.round(n * 1e6) / 1e6;
    }
    const min = out.operator_price_min_per_m_usd;
    const max = out.operator_price_max_per_m_usd;
    if (min !== undefined && max !== undefined && max < min) {
        errors.push("operator_price_max_per_m_usd cannot be below operator_price_min_per_m_usd");
    }

    if (errors.length) return { ok: false, errors };
    return { ok: true, value: out };
}

export function publicTopup(t) {
    if (!t) return null;
    return {
        id: t.id,
        status: t.status,
        amount_usd: Number(t.amount_usd).toFixed(2),
        checkout_url: t.status === "awaiting_payment" ? t.checkout_url : undefined,
        tx_hash: t.tx_hash ?? null,
        created_at: t.created_at,
        paid_at: t.paid_at ?? null
    };
}

export async function insertTopup(user, { amountUsd, amountMicro }) {
    const { data, error } = await db().from("billing_topups").insert({
        user_id: user.id,
        user_email: user.email ?? null,
        amount_usd: amountUsd,
        amount_micro: amountMicro
    }).select(TOPUP_COLUMNS).single();
    if (error) throw withStatus(error.message, 500);
    return data;
}

export async function setTopupCheckout(id, { ref, url }) {
    const { error } = await db().from("billing_topups")
        .update({ payment_ref: ref, checkout_url: url ?? null, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw withStatus(error.message, 500);
}

export async function failTopup(id) {
    await db().from("billing_topups").update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", id).eq("status", "awaiting_payment");
}

export async function getTopup(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ""))) return null;
    const { data, error } = await db().from("billing_topups").select(TOPUP_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw withStatus(error.message, 500);
    return data ?? null;
}

export async function topupByPaymentRef(refs) {
    const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean).map(String);
    if (list.length === 0) return null;
    const { data, error } = await db().from("billing_topups").select(TOPUP_COLUMNS).in("payment_ref", list).limit(1).maybeSingle();
    if (error) throw withStatus(error.message, 500);
    return data ?? null;
}

/**
 * Verify with CoinPay, then credit exactly once. Returns
 * { verdict: "paid"|"unpaid"|"unknown", credited: boolean, topup }.
 * `verify` is injectable for tests; it must ask CoinPay, never the caller.
 */
export async function settleTopup(topup, { verify = verifyTopupAtCoinpay, supabase } = {}) {
    if (!topup) return { verdict: "unpaid", credited: false, topup: null };
    if (topup.status !== "awaiting_payment") return { verdict: topup.status === "paid" ? "paid" : "unpaid", credited: false, topup };
    const check = await verify(topup);
    if (check.verdict !== "paid") return { verdict: check.verdict, credited: false, topup };
    const { data, error } = await db(supabase).rpc("billing_credit_topup", { p_topup_id: topup.id, p_tx_hash: check.txHash ?? null });
    if (error) throw withStatus(error.message, 500);
    const credited = Boolean(data?.credited);
    return { verdict: "paid", credited, topup: { ...topup, status: "paid", tx_hash: check.txHash ?? topup.tx_hash } };
}

/** CoinPay's own word on whether the full top-up amount was collected. */
export function verifyTopupAtCoinpay(topup) {
    return verifyOrderAtCoinpayDetail({ total_usd: Number(topup.amount_usd), payment_ref: topup.payment_ref });
}

/** Funding preview from the DB: { prepaid_available_micro, balance_micro, held_micro, earned_spendable_micro, funding_order }. */
export async function fundingPreview(userId, supabase) {
    const { data, error } = await db(supabase).rpc("billing_funding_preview", { p_user_id: userId });
    if (error) throw withStatus(error.message, 500);
    return data ?? {};
}

export async function setFundingOrder(user, order) {
    const list = cleanFundingOrder(order);
    if (!list) throw withStatus(`funding_order must be a list of distinct sources from ${FUNDING_SOURCES.join(", ")}`, 400);
    const { error } = await db().from("billing_accounts").upsert(
        { user_id: user.id, user_email: user.email ?? null, funding_order: list, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
    );
    if (error) throw withStatus(error.message, 500);
    return list;
}

/**
 * Record and credit a wallet (x402) payment that CoinPay already settled
 * (settleOrderPayment verified and settled it: that is CoinPay's word, not
 * the caller's). The x402 nonce is the payment_ref, unique, so a replayed
 * proof is refused. Returns the topup row.
 */
export async function creditWalletPayment(user, { amountMicro, nonce, txHash }) {
    const amountUsd = microToUsd(amountMicro);
    const { data, error } = await db().from("billing_topups").insert({
        user_id: user.id,
        user_email: user.email ?? null,
        amount_usd: amountUsd,
        amount_micro: amountMicro,
        source: "x402",
        payment_ref: String(nonce),
        tx_hash: txHash ? String(txHash).slice(0, 200) : null
    }).select(TOPUP_COLUMNS).single();
    if (error) {
        if (error.code === "23505" || /duplicate key/.test(error.message ?? "")) throw withStatus("this payment was already used", 409);
        console.error(`[billing] x402 PAID but not recorded: user=${user.id} tx=${txHash} micro=${amountMicro}: ${error.message}`);
        throw withStatus("payment received but could not be recorded; contact support with the tx hash", 500);
    }
    const { error: cErr } = await db().rpc("billing_credit_topup", { p_topup_id: data.id, p_tx_hash: txHash ?? null });
    if (cErr) throw withStatus(cErr.message, 500);
    return data;
}

export async function getBalance(user, { recent = 25 } = {}) {
    const client = db();
    const [preview, { data: rows, error: lErr }] = await Promise.all([
        fundingPreview(user.id, client),
        client.from("billing_ledger").select("kind, amount_micro, batch_id, item_id, topup_id, created_at")
            .eq("user_id", user.id).order("id", { ascending: false }).limit(Math.min(Math.max(Number(recent) || 25, 1), 200))
    ]);
    if (lErr) throw withStatus(lErr.message, 500);
    const balance = Number(preview.balance_micro ?? 0);
    const held = Number(preview.held_micro ?? 0);
    const earned = Number(preview.earned_spendable_micro ?? 0);
    return {
        currency: "USD",
        // Compute balance: prepaid top-ups and wallet payments, plus earnings
        // moved in for batches still running.
        balance_usd: microToUsd(balance),
        held_usd: microToUsd(held),
        prepaid_available_usd: microToUsd(balance - held),
        // Confirmed node earnings (Infernet and c0mpute nodes are one balance)
        // not paid out or requested: spendable on compute, still withdrawable.
        earned_spendable_usd: microToUsd(earned),
        total_spendable_usd: microToUsd(balance - held + earned),
        funding_order: preview.funding_order ?? DEFAULT_FUNDING_ORDER,
        sources: {
            earned: { spendable_usd: microToUsd(earned), note: "confirmed node earnings less payouts; moved in per batch, no fee" },
            prepaid: { available_usd: microToUsd(balance - held), held_usd: microToUsd(held) },
            wallet: { note: "pay a batch's shortfall by x402 (USDC) or a CoinPay checkout at submit" }
        },
        recent: (rows ?? []).map((r) => ({
            kind: r.kind,
            amount_usd: microToUsd(r.amount_micro),
            batch_id: r.batch_id ?? undefined,
            topup_id: r.topup_id ?? undefined,
            at: r.created_at
        }))
    };
}

/** Open a top-up checkout. Shared with the batch submit's checkout path. */
export async function openTopup(user, amountUsd, { minUsd } = {}) {
    const pricing = await getInferencePricing();
    const amount = parseTopupAmount(amountUsd, minUsd ?? pricing.min_topup_usd);
    if (!amount.ok) throw Object.assign(new Error(amount.error), { status: 400 });
    const topup = await insertTopup(user, { amountUsd: amount.usd, amountMicro: amount.micro });
    let checkout;
    try {
        checkout = await createCheckout({
            amountUsd: Number(amount.usd),
            orderId: topup.id,
            description: `Infernet compute balance top-up: $${amount.usd}`,
            email: user.email ?? undefined,
            metadata: { billing_topup_id: topup.id },
            successUrl: `${siteUrl()}/docs/batch-inference#topup`,
            cancelUrl: `${siteUrl()}/docs/batch-inference`,
            idempotencyKey: `topup:${topup.id}`
        });
    } catch (e) {
        await failTopup(topup.id);
        throw Object.assign(new Error(`could not open a CoinPay checkout: ${e?.message ?? e}`), { status: 502 });
    }
    await setTopupCheckout(topup.id, { ref: checkout.id, url: checkout.paymentUrl });
    return {
        topup: publicTopup({ ...topup, payment_ref: checkout.id, checkout_url: checkout.paymentUrl }),
        checkout_url: checkout.paymentUrl,
        next: `Pay at checkout_url, then GET /api/v1/billing/topup/${topup.id} until status is paid.`
    };
}
