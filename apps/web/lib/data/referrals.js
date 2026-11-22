import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getEarningsConfig, approvePayoutRequest } from "@/lib/data/earnings";
import { checkPayoutRequest, isAutoApprovable, OPEN_PAYOUT_STATUSES } from "@/lib/earnings/core";
import {
    resolveReferralConfig,
    generateReferralCode,
    normalizeReferralCode,
    assignArm,
    ipPrefixHash,
    selfReferralReason,
    SELF_REFERRAL_MESSAGES,
    summariseCommissions,
    summariseResults,
    referralTerms
} from "@/lib/referrals/core";

/**
 * Node referrals (DB half). Pure rules: lib/referrals/core.js. Accrual is the
 * SQL trigger post_referral_commission; nothing here writes a commission.
 */

function db() {
    return getSupabaseServerClient();
}

function withStatus(message, status, extra = {}) {
    const err = new Error(message);
    err.status = status;
    Object.assign(err, extra);
    return err;
}

async function selectAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await build().range(from, from + 999);
        if (error) throw withStatus(error.message, 500);
        out.push(...(data ?? []));
        if (!data || data.length < 1000) return out;
    }
}

export async function getReferralConfig() {
    try {
        const { data } = await db().from("settings").select("value").eq("key", "referrals").maybeSingle();
        return resolveReferralConfig(data?.value ?? null);
    } catch {
        return resolveReferralConfig(null);
    }
}

export async function getCodeRow(userId) {
    const { data, error } = await db().from("referral_codes").select("*").eq("user_id", userId).maybeSingle();
    if (error) throw withStatus(error.message, 500);
    return data ?? null;
}

/**
 * The referrer's code, created on first call. The A/B arm is drawn here,
 * once; a repeat call returns the same row (and the same arm).
 */
export async function getOrCreateCode(userId, { ip = null } = {}) {
    if (!userId) throw withStatus("sign in first", 401);
    const existing = await getCodeRow(userId);
    if (existing) return { row: existing, created: false };
    const cfg = await getReferralConfig();
    if (!cfg.enabled) throw withStatus(SELF_REFERRAL_MESSAGES.disabled, 403);
    const arm = assignArm();
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data, error } = await db()
            .from("referral_codes")
            .insert({ user_id: userId, code: generateReferralCode(), arm, created_ip24: ipPrefixHash(ip) })
            .select("*")
            .single();
        if (!error) return { row: data, created: true };
        // Lost a race with ourselves (same user): return the winner.
        if (/referral_codes_pkey/.test(error.message)) return { row: await getCodeRow(userId), created: false };
        if (!/duplicate key|referral_codes_code_key/.test(error.message)) throw withStatus(error.message, 500);
    }
    throw withStatus("could not allocate a referral code, try again", 503);
}

/** Public lookup for /r/<code>: whether it exists, plus the terms. No referrer identity. */
export async function lookupCode(raw) {
    const code = normalizeReferralCode(raw);
    const [config, earnings] = await Promise.all([getReferralConfig(), getEarningsConfig()]);
    if (!code) return { valid: false, code: null, terms: referralTerms({ config, earnings }) };
    const { data } = await db().from("referral_codes").select("code").eq("code", code).maybeSingle();
    return { valid: Boolean(data), code, terms: referralTerms({ config, earnings }) };
}

export async function setReferralPayoutAddress(userId, { coin, network, address }) {
    const c = typeof coin === "string" ? coin.trim().toUpperCase() : "";
    const n = typeof network === "string" ? network.trim().toLowerCase() : "";
    const a = typeof address === "string" ? address.trim() : "";
    if (!/^[A-Z0-9]{2,12}$/.test(c) || !/^[a-z0-9-]{2,24}$/.test(n) || a.length < 20 || a.length > 128 || /\s/.test(a)) {
        throw withStatus("coin, network and address are required (e.g. USDC polygon 0x...)", 400);
    }
    const { row } = await getOrCreateCode(userId);
    const { data, error } = await db()
        .from("referral_codes")
        .update({ payout_coin: c, payout_network: n, payout_address: a, updated_at: new Date().toISOString() })
        .eq("user_id", row.user_id)
        .select("*")
        .single();
    if (error) throw withStatus(error.message, 500);
    return data;
}

/** Everything the "Refer a node" page and referral_stats show. */
export async function getReferralOverview(userId) {
    const supabase = db();
    const [row, config, earnings] = await Promise.all([getCodeRow(userId), getReferralConfig(), getEarningsConfig()]);
    if (!row) return { has_code: false, terms: referralTerms({ config, earnings }) };
    const [attributions, commissions, payouts] = await Promise.all([
        selectAll(() => supabase
            .from("referral_attributions")
            .select("node_key, via, attributed_at, first_settled_at, provider_id")
            .eq("referrer_user_id", userId)
            .order("attributed_at", { ascending: false })),
        selectAll(() => supabase
            .from("referral_commissions")
            .select("id, node_key, job_id, fee_usd, commission_pct, amount_usd, status, earned_at")
            .eq("referrer_user_id", userId)
            .order("earned_at", { ascending: false })),
        selectAll(() => supabase
            .from("payout_requests")
            .select("id, amount_usd, coin, network, status, tx_hash, error, created_at, sent_at")
            .eq("referrer_user_id", userId)
            .order("created_at", { ascending: false }))
    ]);
    const cutoff = Date.now() - 7 * 86400_000;
    const activeNodes = new Set(commissions.filter((c) => c.status !== "void" && Date.parse(c.earned_at) >= cutoff).map((c) => c.node_key));
    return {
        has_code: true,
        code: row.code,
        arm: row.arm,
        created_at: row.created_at,
        payout_address: row.payout_address
            ? { coin: row.payout_coin, network: row.payout_network, address: row.payout_address }
            : null,
        terms: referralTerms({ config, earnings, arm: row.arm }),
        nodes: attributions.map((a) => ({
            node: publicNodeLabel(a.node_key),
            via: a.via,
            attributed_at: a.attributed_at,
            first_paid_job_at: a.first_settled_at
        })),
        referred_nodes: attributions.length,
        active_nodes_7d: activeNodes.size,
        balance: summariseCommissions(commissions, payouts),
        recent: commissions.slice(0, 25).map((c) => ({ ...c, node: publicNodeLabel(c.node_key), node_key: undefined })),
        payouts: payouts.slice(0, 20)
    };
}

/** What a referrer sees of a node: the c0mpute board id or a short node id, never more. */
export function publicNodeLabel(nodeKey) {
    const s = String(nodeKey ?? "");
    const c0 = /^c0mpute:([1-9A-HJ-NP-Za-km-z]+)$/.exec(s);
    if (c0) return `c0mpute ${c0[1].slice(-8)}`;
    return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

// ---- attribution ------------------------------------------------------------

async function providerByNodeKey(nodeKey) {
    const { data, error } = await db()
        .from("providers")
        .select("id, public_key, address")
        .eq("node_id", nodeKey)
        .maybeSingle();
    if (error) throw withStatus(error.message, 500);
    return data ?? null;
}

async function ownerOfPubkey(pubkey) {
    if (!pubkey) return null;
    const { data } = await db().from("pubkey_links").select("user_id").eq("pubkey", pubkey).eq("role", "provider").limit(1).maybeSingle();
    return data?.user_id ?? null;
}

/** The referrer's own nodes: their payout addresses and network prefixes. */
async function referrerFootprint(userId) {
    const supabase = db();
    const { data: links } = await supabase.from("pubkey_links").select("pubkey").eq("user_id", userId).eq("role", "provider");
    const pubkeys = (links ?? []).map((l) => l.pubkey);
    if (pubkeys.length === 0) return { provider_addresses: [], provider_ip24s: [] };
    const { data: providers } = await supabase.from("providers").select("id, address").in("public_key", pubkeys);
    const ids = (providers ?? []).map((p) => p.id);
    const { data: payouts } = ids.length
        ? await supabase.from("provider_payouts").select("address").in("provider_id", ids)
        : { data: [] };
    return {
        provider_addresses: (payouts ?? []).map((p) => p.address),
        provider_ip24s: (providers ?? []).map((p) => ipPrefixHash(p.address)).filter(Boolean)
    };
}

/**
 * Attribute a node to the owner of `code`. Called when a node registers
 * (`infernet register --ref`) or when a c0mpute node presents a signed claim.
 * Refused once the node has settled a fee-bearing job, when it already has a
 * referrer, and on any self-referral signal. Returns { attributed, reason }.
 *
 *   nodeKey      providers.node_id: the daemon's node id, or `c0mpute:<peer>`
 *   ownerUserId  the node operator's account when known
 *   ip           the registering request's address (only its /24 hash is kept)
 */
export async function attributeNode({ nodeKey, code: rawCode, via, ip = null, ownerUserId = null }) {
    const code = normalizeReferralCode(rawCode);
    if (!code) return { attributed: false, reason: "unknown_code", message: SELF_REFERRAL_MESSAGES.unknown_code };
    const cfg = await getReferralConfig();
    if (!cfg.enabled) return { attributed: false, reason: "disabled", message: SELF_REFERRAL_MESSAGES.disabled };
    const supabase = db();

    const { data: existing } = await supabase
        .from("referral_attributions")
        .select("referrer_user_id, code")
        .eq("node_key", nodeKey)
        .maybeSingle();
    if (existing) {
        return existing.code === code
            ? { attributed: true, already: true, reason: null }
            : { attributed: false, reason: "already_attributed", message: SELF_REFERRAL_MESSAGES.already_attributed };
    }

    const { data: codeRow } = await supabase.from("referral_codes").select("*").eq("code", code).maybeSingle();
    if (!codeRow) return { attributed: false, reason: "unknown_code", message: SELF_REFERRAL_MESSAGES.unknown_code };

    const provider = await providerByNodeKey(nodeKey);
    if (provider) {
        // "At registration": once a node has settled a fee-bearing job, it
        // was not brought in by this referral.
        const { count } = await supabase
            .from("provider_earnings")
            .select("id", { count: "exact", head: true })
            .eq("provider_id", provider.id)
            .in("kind", ["paid", "reservation"])
            .gt("fee_usd", 0);
        if ((count ?? 0) > 0) return { attributed: false, reason: "already_earning", message: SELF_REFERRAL_MESSAGES.already_earning };
    }
    const owner = ownerUserId ?? (await ownerOfPubkey(provider?.public_key));
    const { data: nodePayouts } = provider
        ? await supabase.from("provider_payouts").select("address").eq("provider_id", provider.id)
        : { data: [] };
    const footprint = await referrerFootprint(codeRow.user_id);
    const ip24 = ipPrefixHash(ip);
    const reason = selfReferralReason({
        referrer: {
            user_id: codeRow.user_id,
            payout_address: codeRow.payout_address,
            created_ip24: codeRow.created_ip24,
            ...footprint
        },
        node: {
            owner_user_id: owner,
            payout_addresses: (nodePayouts ?? []).map((p) => p.address),
            ip24: ip24 ?? ipPrefixHash(provider?.address)
        }
    });
    if (reason) return { attributed: false, reason, message: SELF_REFERRAL_MESSAGES[reason] };

    const { error } = await supabase.from("referral_attributions").insert({
        node_key: nodeKey,
        referrer_user_id: codeRow.user_id,
        code,
        arm: codeRow.arm,
        via,
        provider_id: provider?.id ?? null,
        node_owner_user_id: owner,
        ip24
    });
    if (error) {
        if (/duplicate key|referral_attributions_pkey/.test(error.message)) {
            return { attributed: false, reason: "already_attributed", message: SELF_REFERRAL_MESSAGES.already_attributed };
        }
        throw withStatus(error.message, 500);
    }
    return { attributed: true, reason: null };
}

// ---- payouts ----------------------------------------------------------------

/**
 * Withdraw confirmed commissions through the same payout path as node
 * earnings: same minimum, same auto-approve cap, same CoinPay send.
 */
export async function requestReferralPayout({ userId, amountUsd = null, via = "dashboard", send } = {}) {
    const supabase = db();
    const [config, overview] = await Promise.all([getEarningsConfig(supabase), getReferralOverview(userId)]);
    if (!overview.has_code) throw withStatus("create your referral link first", 400);
    const hasOpenRequest = (overview.payouts ?? []).some((p) => OPEN_PAYOUT_STATUSES.includes(p.status));
    const check = checkPayoutRequest({
        balance: overview.balance,
        amountUsd,
        config,
        hasAddress: Boolean(overview.payout_address),
        hasOpenRequest
    });
    if (!check.ok) {
        throw withStatus(check.error.replace("infernet payout set <coin> <address>", "infernet referral address <coin> <network> <address>"), 400);
    }
    const addr = overview.payout_address;
    const { data, error } = await supabase
        .from("payout_requests")
        .insert({
            provider_id: null,
            referrer_user_id: userId,
            amount_usd: check.amount,
            coin: addr.coin,
            network: addr.network,
            address: addr.address,
            status: "requested",
            requested_via: via,
            metadata: { kind: "referral_commission" }
        })
        .select()
        .single();
    if (error) {
        if (/one_open|duplicate key/.test(error.message)) throw withStatus("a payout request is already waiting for approval", 409);
        if (/insufficient_earnings/.test(error.message)) throw withStatus("that amount is no longer available", 409);
        throw withStatus(error.message, 500);
    }
    if (isAutoApprovable(data.amount_usd, config)) {
        try {
            const out = await approvePayoutRequest(data.id, { actor: "auto-approve", send });
            return { request: out.request, outcome: out.outcome, auto_approved: true, balance: overview.balance };
        } catch (err) {
            console.warn(`referral payout auto-approve ${data.id} failed: ${err?.message ?? err}`);
        }
    }
    return { request: data, balance: overview.balance };
}

// ---- admin results ----------------------------------------------------------

export async function getReferralResults({ activeDays = 7 } = {}) {
    const supabase = db();
    const [codes, attributions, commissions, payouts, config, earnings] = await Promise.all([
        selectAll(() => supabase.from("referral_codes").select("user_id, arm, created_at").order("user_id")),
        selectAll(() => supabase.from("referral_attributions").select("node_key, referrer_user_id, arm, provider_id, first_settled_at, attributed_at, via").order("node_key")),
        selectAll(() => supabase.from("referral_commissions").select("referrer_user_id, arm, amount_usd, status").order("id")),
        selectAll(() => supabase.from("payout_requests").select("referrer_user_id, amount_usd, status").not("referrer_user_id", "is", null).order("id")),
        getReferralConfig(),
        getEarningsConfig()
    ]);
    const providerIds = [...new Set(attributions.map((a) => a.provider_id).filter(Boolean))];
    const credits = [];
    for (let i = 0; i < providerIds.length; i += 100) {
        credits.push(...await selectAll(() => supabase
            .from("provider_earnings")
            .select("provider_id, kind, status, gross_usd, fee_usd, amount_usd, earned_at")
            .in("provider_id", providerIds.slice(i, i + 100))
            .in("kind", ["paid", "reservation"])
            .order("id")));
    }
    // Attributions made before the node's provider row existed (a c0mpute
    // node claims before its first job): resolve them by node_id now.
    const unresolved = attributions.filter((a) => !a.provider_id).map((a) => a.node_key);
    if (unresolved.length) {
        const { data } = await supabase.from("providers").select("id, node_id").in("node_id", unresolved.slice(0, 500));
        const idOf = new Map((data ?? []).map((p) => [p.node_id, p.id]));
        const extra = [];
        for (const a of attributions) {
            if (!a.provider_id && idOf.has(a.node_key)) {
                a.provider_id = idOf.get(a.node_key);
                extra.push(a.provider_id);
            }
        }
        for (let i = 0; i < extra.length; i += 100) {
            credits.push(...await selectAll(() => supabase
                .from("provider_earnings")
                .select("provider_id, kind, status, gross_usd, fee_usd, amount_usd, earned_at")
                .in("provider_id", extra.slice(i, i + 100))
                .in("kind", ["paid", "reservation"])
                .order("id")));
        }
    }
    return {
        ...summariseResults({ codes, attributions, credits, commissions, payouts, activeDays }),
        config,
        house_fee_pct: earnings.house_fee_pct,
        totals: { codes: codes.length, attributions: attributions.length, commissions: commissions.length }
    };
}
