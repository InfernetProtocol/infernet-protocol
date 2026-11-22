import { createHash, createPublicKey, verify as verifySignature, randomInt } from "node:crypto";

/**
 * Node referrals (pure half). The DB half is lib/data/referrals.js; accrual
 * itself is the SQL trigger post_referral_commission (migration
 * 20261122120000_node_referrals.sql), which this file mirrors so the math has
 * tests.
 *
 * Model (Anthony, 2026-11-22):
 * - A referrer earns commission_pct_of_house_fee (5) percent of the HOUSE FEE
 *   on every settled job a node they referred serves. The commission comes out
 *   of the house fee, never out of the operator's earnings, and is never more
 *   than the house earned on that job. A job with no house fee (free tier,
 *   subsidy) earns nothing.
 * - A/B test on the commission term: each referrer is assigned once, 50/50,
 *   when their code is created: "12m" (commission for 12 months from the
 *   referred node's first settled job) or "lifetime". Sticky per referrer.
 * - A node is attributed when it registers (infernet register --ref, or a
 *   c0mpute node's signed claim), before its first settled job, and never
 *   changes after. One referrer per node.
 */

export const ARMS = Object.freeze(["12m", "lifetime"]);
export const ARM_LABELS = Object.freeze({
    "12m": "12 months from each referred node's first paid job",
    lifetime: "for as long as each referred node serves paid jobs"
});

export const DEFAULT_REFERRAL_CONFIG = Object.freeze({
    enabled: true,
    // The single config value: percent of the house fee paid to the referrer.
    commission_pct_of_house_fee: 5,
    term_months_12m: 12
});

/** Settings row 'referrals' over the defaults; malformed values fall back. */
export function resolveReferralConfig(settings = null) {
    const s = settings && typeof settings === "object" ? settings : {};
    const pct = Number(s.commission_pct_of_house_fee);
    const months = Number(s.term_months_12m);
    return {
        enabled: s.enabled === undefined ? DEFAULT_REFERRAL_CONFIG.enabled : s.enabled === true || s.enabled === "true",
        commission_pct_of_house_fee: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : DEFAULT_REFERRAL_CONFIG.commission_pct_of_house_fee,
        term_months_12m: Number.isInteger(months) && months > 0 && months <= 120 ? months : DEFAULT_REFERRAL_CONFIG.term_months_12m
    };
}

// ---- codes ------------------------------------------------------------------

// No 0/o/1/l/i: codes get read aloud and typed into terminals.
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function generateReferralCode(rand = randomInt) {
    let out = "";
    for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
    return out;
}

/** Normalize a code someone typed or pasted (case, spaces, a whole /r/ URL). */
export function normalizeReferralCode(raw) {
    if (typeof raw !== "string") return null;
    let s = raw.trim();
    const m = /\/r\/([A-Za-z0-9]+)\/?(?:[?#].*)?$/.exec(s);
    if (m) s = m[1];
    s = s.toLowerCase();
    return /^[a-z0-9]{6,16}$/.test(s) ? s : null;
}

/** 50/50, once, at code creation. `rand` returns [0, 1). */
export function assignArm(rand = Math.random) {
    return rand() < 0.5 ? "12m" : "lifetime";
}

export function referralUrl(origin, code) {
    return `${String(origin).replace(/\/+$/, "")}/r/${code}`;
}

/**
 * Share links and the install commands that carry the code. Attribution
 * happens on the install path operators actually use: the code rides into
 * the node's registration (INFERNET_REFERRAL / C0MPUTE_REF on the
 * installers, --ref on the register commands).
 */
export function referralLinks(code, { infernetOrigin = "https://infernetprotocol.com", c0mputeOrigin = "https://c0mpute.com" } = {}) {
    return {
        links: { infernet: referralUrl(infernetOrigin, code), c0mpute: referralUrl(c0mputeOrigin, code) },
        install: {
            infernet: `curl -fsSL https://infernetprotocol.com/install.sh | INFERNET_REFERRAL=${code} sh`,
            infernet_register: `infernet register --ref ${code}`,
            c0mpute: `curl -fsSL https://c0mpute.com/install.sh | C0MPUTE_REF=${code} sh`,
            c0mpute_register: `c0mpute worker register --ref ${code}`
        }
    };
}

// ---- self-referral heuristics ----------------------------------------------

/** The /24 (IPv4) or /48 (IPv6) of an address, or null. */
export function ipPrefix(ip) {
    if (typeof ip !== "string") return null;
    let s = ip.trim().replace(/^::ffff:/i, "");
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (v4) {
        const parts = v4.slice(1, 5).map(Number);
        if (parts.some((n) => n > 255)) return null;
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    if (s.includes(":")) {
        s = s.split("%")[0].toLowerCase();
        const [head] = s.split("::");
        const groups = head.split(":").filter(Boolean);
        while (groups.length < 3) groups.push("0");
        return `${groups.slice(0, 3).join(":")}::/48`;
    }
    return null;
}

/** sha256 of the prefix: comparable, and the address itself is never stored. */
export function ipPrefixHash(ip, salt = "infernet-referrals") {
    const p = ipPrefix(ip);
    return p ? createHash("sha256").update(`${salt}:${p}`).digest("hex") : null;
}

/**
 * Why attributing this node to this referrer is refused, or null when it is
 * fine. Inputs are what the server knows at registration time.
 *   referrer: { user_id, payout_address, created_ip24, provider_addresses[], provider_ip24s[] }
 *   node:     { owner_user_id, payout_addresses[], ip24 }
 */
export function selfReferralReason({ referrer, node }) {
    if (!referrer?.user_id) return "unknown_code";
    if (node?.owner_user_id && node.owner_user_id === referrer.user_id) return "same_account";
    const lower = (v) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);
    const referrerWallets = new Set([referrer.payout_address, ...(referrer.provider_addresses ?? [])].map(lower).filter(Boolean));
    for (const addr of (node?.payout_addresses ?? []).map(lower).filter(Boolean)) {
        if (referrerWallets.has(addr)) return "same_payout_wallet";
    }
    const nodeNet = node?.ip24 ?? null;
    if (nodeNet && (nodeNet === referrer.created_ip24 || (referrer.provider_ip24s ?? []).includes(nodeNet))) {
        return "same_network";
    }
    return null;
}

export const SELF_REFERRAL_MESSAGES = Object.freeze({
    unknown_code: "that referral code does not exist",
    same_account: "a node cannot be referred by its own operator",
    same_payout_wallet: "this node shares a payout wallet with the referrer, so it counts as a self-referral",
    same_network: "this node is on the same network as the referrer, so it counts as a self-referral",
    already_attributed: "this node already has a referrer (attribution never changes)",
    already_earning: "this node has already settled jobs; a referral can only be set when a node first registers",
    disabled: "node referrals are turned off right now"
});

// ---- accrual math (mirrors post_referral_commission) -----------------------

function round8(n) {
    return Math.round(n * 1e8) / 1e8;
}

/** Commission on one credit: pct of its house fee, never above the fee, 0 for no fee. */
export function commissionFor({ feeUsd, pct }) {
    const fee = Number(feeUsd);
    const p = Math.min(Math.max(Number(pct) || 0, 0), 100);
    if (!Number.isFinite(fee) || fee <= 0 || p <= 0) return 0;
    return Math.min(round8((fee * p) / 100), fee);
}

/** Add calendar months like Postgres `timestamp + interval 'N months'` (clamps the day). */
export function addMonths(date, months) {
    const d = new Date(date);
    const day = d.getUTCDate();
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1,
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target;
}

/** Whether a credit earned at `earnedAt` is inside the arm's term. */
export function withinTerm({ arm, firstSettledAt, earnedAt, months = DEFAULT_REFERRAL_CONFIG.term_months_12m }) {
    if (arm === "lifetime") return true;
    if (arm !== "12m") return false;
    const earned = new Date(earnedAt);
    const first = firstSettledAt ? new Date(firstSettledAt) : earned;
    return earned.getTime() < addMonths(first, months).getTime();
}

/**
 * The commission row a credit produces for an attribution, or null. Same
 * rules, in the same order, as the SQL trigger.
 */
export function commissionRowFor({ earning, attribution, config, nodeOwnerUserId = null, referrerPayoutAddress = null, nodePayoutAddresses = [] }) {
    const cfg = resolveReferralConfig(config);
    if (!earning || !attribution || !cfg.enabled) return null;
    if (!["paid", "reservation"].includes(earning.kind)) return null;
    const fee = Number(earning.fee_usd) || 0;
    if (fee <= 0 || earning.status === "void") return null;
    if (new Date(earning.earned_at) < new Date(attribution.attributed_at)) return null;
    const owner = nodeOwnerUserId ?? attribution.node_owner_user_id ?? null;
    if (owner && owner === attribution.referrer_user_id) return null;
    const payer = earning.metadata?.billed_user_id ?? null;
    if (payer && (payer === attribution.referrer_user_id || (owner && payer === owner))) return null;
    const wallet = referrerPayoutAddress ? referrerPayoutAddress.toLowerCase() : null;
    if (wallet && nodePayoutAddresses.some((a) => String(a).toLowerCase() === wallet)) return null;
    const first = attribution.first_settled_at && new Date(attribution.first_settled_at) < new Date(earning.earned_at)
        ? attribution.first_settled_at
        : earning.earned_at;
    if (!withinTerm({ arm: attribution.arm, firstSettledAt: first, earnedAt: earning.earned_at, months: cfg.term_months_12m })) return null;
    const pct = cfg.commission_pct_of_house_fee;
    const amount = commissionFor({ feeUsd: fee, pct });
    if (amount <= 0 && pct <= 0) return null;
    return {
        source_earning_id: earning.id,
        referrer_user_id: attribution.referrer_user_id,
        node_key: attribution.node_key,
        provider_id: earning.provider_id,
        job_id: earning.job_id ?? null,
        reservation_id: earning.reservation_id ?? null,
        arm: attribution.arm,
        fee_usd: fee,
        commission_pct: pct,
        amount_usd: amount,
        status: earning.status,
        earned_at: earning.earned_at,
        confirmed_at: earning.confirmed_at ?? null,
        first_settled_at: first
    };
}

/**
 * Apply credits to a ledger the way the trigger does: one row per source
 * credit, a repeat of the same credit (a retried settle) changes nothing new,
 * and a later status change on the source moves the commission with it.
 */
export function applyCreditsToLedger(ledger, credits, ctx) {
    const byId = new Map(ledger.map((r) => [r.source_earning_id, { ...r }]));
    let attribution = { ...ctx.attribution };
    for (const e of credits) {
        const existing = byId.get(e.id);
        if (existing) {
            const fee = Number(e.fee_usd) || 0;
            existing.status = fee <= 0 ? "void" : e.status;
            existing.fee_usd = Math.max(fee, 0);
            existing.amount_usd = fee <= 0 ? 0 : commissionFor({ feeUsd: fee, pct: existing.commission_pct });
            existing.confirmed_at = e.confirmed_at ?? null;
            continue;
        }
        const row = commissionRowFor({ ...ctx, earning: e, attribution });
        // The node's term starts at its first fee-bearing job, whether or not
        // that job itself paid a commission.
        if (Number(e.fee_usd) > 0 && e.status !== "void" && ["paid", "reservation"].includes(e.kind)) {
            if (!attribution.first_settled_at || new Date(e.earned_at) < new Date(attribution.first_settled_at)) {
                attribution = { ...attribution, first_settled_at: e.earned_at };
            }
        }
        if (row) {
            const { first_settled_at: _f, ...rest } = row;
            byId.set(e.id, rest);
        }
    }
    return { ledger: [...byId.values()], attribution };
}

// ---- c0mpute node claims -----------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s) {
    if (typeof s !== "string" || !s) return null;
    let n = 0n;
    for (const ch of s) {
        const v = B58.indexOf(ch);
        if (v < 0) return null;
        n = n * 58n + BigInt(v);
    }
    const bytes = [];
    while (n > 0n) {
        bytes.unshift(Number(n & 0xffn));
        n >>= 8n;
    }
    for (const ch of s) {
        if (ch !== "1") break;
        bytes.unshift(0);
    }
    return Buffer.from(bytes);
}

/**
 * The raw 32-byte ed25519 key inside a libp2p peer id ("12D3KooW..."), or
 * null. Such a peer id is an identity multihash (0x00, len 36) of the
 * protobuf PublicKey { Type: Ed25519 (1), Data: 32 bytes }.
 */
export function ed25519KeyFromPeerId(peerId) {
    const b = base58Decode(peerId);
    if (!b || b.length !== 38) return null;
    if (b[0] !== 0x00 || b[1] !== 36) return null;
    if (b[2] !== 0x08 || b[3] !== 0x01 || b[4] !== 0x12 || b[5] !== 0x20) return null;
    return b.subarray(6, 38);
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The exact bytes a c0mpute node signs to claim a referral. */
export function c0mputeClaimMessage({ peerId, code, ts }) {
    return `c0mpute-referral:v1:${peerId}:${code}:${ts}`;
}

/**
 * Verify a c0mpute node's signed referral claim: the node proves it holds the
 * key behind its peer id, so nobody can attach a code to someone else's node.
 * `sig` is base64 (standard or url-safe). `ts` is unix seconds, accepted for
 * 15 minutes either way.
 */
export function verifyC0mputeClaim({ peerId, code, ts, sig, now = Date.now() }) {
    const key = ed25519KeyFromPeerId(peerId);
    if (!key) return { ok: false, error: "peer_id must be an ed25519 libp2p peer id (12D3KooW...)" };
    const t = Number(ts);
    if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > 15 * 60) return { ok: false, error: "claim timestamp is too old or in the future" };
    if (typeof sig !== "string" || !sig) return { ok: false, error: "signature required" };
    let sigBytes;
    try {
        sigBytes = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    } catch {
        return { ok: false, error: "signature is not base64" };
    }
    if (sigBytes.length !== 64) return { ok: false, error: "signature must be 64 bytes" };
    try {
        const pub = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key]), format: "der", type: "spki" });
        const good = verifySignature(null, Buffer.from(c0mputeClaimMessage({ peerId, code, ts: t })), pub, sigBytes);
        return good ? { ok: true } : { ok: false, error: "signature does not match the peer id" };
    } catch {
        return { ok: false, error: "signature check failed" };
    }
}

// ---- referrer view + results ------------------------------------------------

function roundUsd(n) {
    return Math.round((Number(n) || 0) * 1e8) / 1e8;
}

/** A referrer's commission balance (same shape as a node balance). */
export function summariseCommissions(commissions = [], payouts = []) {
    const sum = (rows) => roundUsd(rows.reduce((a, r) => a + (Number(r.amount_usd) || 0), 0));
    const by = (s) => commissions.filter((c) => c.status === s);
    const confirmed = sum(by("confirmed"));
    const open = sum(payouts.filter((p) => ["requested", "approved", "sending"].includes(p.status)));
    const paid = sum(payouts.filter((p) => p.status === "sent"));
    return {
        pending_usd: roundUsd(sum(by("pending")) + sum(by("pending_approval"))),
        confirmed_usd: confirmed,
        requested_usd: open,
        paid_usd: paid,
        available_usd: roundUsd(Math.max(0, confirmed - open - paid)),
        commissions: commissions.filter((c) => c.status !== "void").length
    };
}

/**
 * Per-arm results for the experiment. Inputs are plain rows:
 *   codes        [{ user_id, arm }]
 *   attributions [{ node_key, referrer_user_id, arm, provider_id, first_settled_at }]
 *   credits      [{ provider_id, kind, status, gross_usd, fee_usd, amount_usd, earned_at }] (referred providers only)
 *   commissions  [{ referrer_user_id, arm, amount_usd, status }]
 *   payouts      [{ referrer_user_id, amount_usd, status }]
 * "Active" = a referred node with a non-void credit in the last `activeDays`.
 */
export function summariseResults({ codes = [], attributions = [], credits = [], commissions = [], payouts = [], now = Date.now(), activeDays = 7 }) {
    const armOf = new Map(codes.map((c) => [c.user_id, c.arm]));
    const out = {};
    for (const arm of ARMS) {
        out[arm] = {
            arm,
            label: ARM_LABELS[arm],
            referrers: 0,
            referrers_with_nodes: 0,
            referred_nodes: 0,
            nodes_with_paid_jobs: 0,
            active_nodes: 0,
            referred_revenue_usd: 0,
            house_fee_usd: 0,
            commissions_accrued_usd: 0,
            commissions_confirmed_usd: 0,
            commissions_paid_usd: 0
        };
    }
    for (const c of codes) if (out[c.arm]) out[c.arm].referrers += 1;
    const providerArm = new Map();
    const referrersWithNodes = { "12m": new Set(), lifetime: new Set() };
    for (const a of attributions) {
        const arm = out[a.arm] ? a.arm : armOf.get(a.referrer_user_id);
        if (!out[arm]) continue;
        out[arm].referred_nodes += 1;
        referrersWithNodes[arm].add(a.referrer_user_id);
        if (a.first_settled_at) out[arm].nodes_with_paid_jobs += 1;
        if (a.provider_id) providerArm.set(a.provider_id, arm);
    }
    for (const arm of ARMS) out[arm].referrers_with_nodes = referrersWithNodes[arm].size;
    const cutoff = now - activeDays * 86400_000;
    const active = { "12m": new Set(), lifetime: new Set() };
    for (const e of credits) {
        const arm = providerArm.get(e.provider_id);
        if (!arm || e.status === "void" || !["paid", "reservation"].includes(e.kind)) continue;
        out[arm].referred_revenue_usd += Number(e.gross_usd) || (Number(e.amount_usd) || 0) + (Number(e.fee_usd) || 0);
        out[arm].house_fee_usd += Number(e.fee_usd) || 0;
        if (new Date(e.earned_at).getTime() >= cutoff) active[arm].add(e.provider_id);
    }
    for (const arm of ARMS) out[arm].active_nodes = active[arm].size;
    for (const c of commissions) {
        const arm = out[c.arm] ? c.arm : armOf.get(c.referrer_user_id);
        if (!out[arm] || c.status === "void") continue;
        out[arm].commissions_accrued_usd += Number(c.amount_usd) || 0;
        if (c.status === "confirmed") out[arm].commissions_confirmed_usd += Number(c.amount_usd) || 0;
    }
    for (const p of payouts) {
        const arm = armOf.get(p.referrer_user_id);
        if (!out[arm] || p.status !== "sent") continue;
        out[arm].commissions_paid_usd += Number(p.amount_usd) || 0;
    }
    for (const arm of ARMS) {
        for (const k of ["referred_revenue_usd", "house_fee_usd", "commissions_accrued_usd", "commissions_confirmed_usd", "commissions_paid_usd"]) {
            out[arm][k] = roundUsd(out[arm][k]);
        }
    }
    return { arms: ARMS.map((a) => out[a]), active_days: activeDays, generated_at: new Date(now).toISOString() };
}

/**
 * The public terms, from live config, so the page never states a number the
 * ledger does not use. `arm` personalises "your commission term" without
 * saying there is more than one.
 */
export function referralTerms({ config, earnings, arm = null }) {
    const cfg = resolveReferralConfig(config);
    const fee = Number(earnings?.house_fee_pct);
    const pct = cfg.commission_pct_of_house_fee;
    const ofRevenue = Number.isFinite(fee) ? Math.round(pct * fee) / 100 : null;
    return {
        commission_pct_of_house_fee: pct,
        house_fee_pct: Number.isFinite(fee) ? fee : null,
        effective_pct_of_node_revenue: ofRevenue,
        term: arm ? { arm, label: ARM_LABELS[arm] ?? null, months: arm === "12m" ? cfg.term_months_12m : null } : null,
        min_payout_usd: Number(earnings?.min_payout_usd) || 0,
        auto_approve_max_usd: Number(earnings?.auto_approve_max_usd) || 0,
        enabled: cfg.enabled
    };
}
