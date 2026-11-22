// Network leaderboard raw material for c0mpute.com/leaderboard.
//
// Pure: takes ledger rows, returns per-window rankings in which nobody is
// named. Every person, provider and referrer is a token: HMAC-SHA256 keyed
// with the CALLER's trusted client key over "sub:<coinpay sub>" (or
// "user:<id>" / "provider:<id>" when there is no CoinPay link). Raw ids,
// emails, wallets and provider names never leave this module, and a token is
// useless to anyone without that caller's key: another trusted client gets
// different tokens for the same person, so two clients cannot join their
// answers. The caller (c0mpute.com) computes the same token for its own
// signed-in users from the CoinPay sub it already holds, which is how it
// honours "hide me from the leaderboard" and merges a person's c0mpute and
// Infernet activity under one public handle.
//
// c0mpute nodes keep their public board id (the last 8 characters of the
// peer id), which is already public on c0mpute.com/nodes.
import { createHmac } from "node:crypto";
import { NOT_JOB_KINDS, c0mputeNodeOf, roundUsd } from "../earnings/core.js";

export const LEADERBOARD_WINDOWS = Object.freeze({
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
});

/** Rows per list in the answer. The page shows ten. */
export const LEADERBOARD_LIMIT = 50;

/** The caller-keyed token for one label. */
export function leaderboardToken(key, label) {
    return createHmac("sha256", String(key)).update(String(label)).digest("hex");
}

const at = (r) => Date.parse(r.earned_at ?? r.created_at ?? "") || 0;
const lower = (v) => String(v ?? "").toLowerCase();

/**
 * @param {object} rows
 *   earnings     provider_earnings: id, provider_id, kind, status, amount_usd, output_tokens, model_name, billed, earned_at|created_at
 *   providers    providers: id, node_id, public_key, is_public, archived_at, archived_is_public
 *   links        pubkey_links: pubkey, user_id, role
 *   identities   coinpay_identities: user_id, coinpay_sub
 *   charges      billing_ledger kind 'charge': user_id, amount_micro, created_at
 *   commissions  referral_commissions: referrer_user_id, status, amount_usd, earned_at
 *   attributions referral_attributions: referrer_user_id, attributed_at
 * @param {object} opts  key (the caller's bearer), now, adminIds (house accounts: never ranked as customers), limit
 */
export function summariseLeaderboard(rows, { key, now = Date.now(), adminIds = [], limit = LEADERBOARD_LIMIT } = {}) {
    if (!key) throw new Error("leaderboard needs the caller's key");
    const {
        earnings = [], providers = [], links = [], identities = [],
        charges = [], commissions = [], attributions = []
    } = rows ?? {};

    const subByUser = new Map(identities.filter((i) => i?.user_id && i?.coinpay_sub).map((i) => [lower(i.user_id), i.coinpay_sub]));
    const personToken = (userId) => {
        const sub = subByUser.get(lower(userId));
        return leaderboardToken(key, sub ? `sub:${sub}` : `user:${lower(userId)}`);
    };
    const ownerByPubkey = new Map();
    for (const l of links) if (l?.role === "provider" && l.pubkey && l.user_id) ownerByPubkey.set(l.pubkey, l.user_id);

    // Providers an operator hid (is_public false, or archived as private) never appear.
    // Exception: the provider Infernet opens for a c0mpute node (node_id
    // `c0mpute:<peer>`) is created is_public false by the bridge itself
    // (lib/data/chat-c0mpute.js), to keep it off Infernet's own provider list;
    // nobody chose that. The node is public on c0mpute.com/nodes, and c0mpute
    // applies its operator's own leaderboard opt-out, so it stays in.
    const providerInfo = new Map();
    for (const p of providers) {
        if (!p?.id) continue;
        const c0mputeNode = c0mputeNodeOf(p.node_id);
        const hidden = (p.is_public === false && !c0mputeNode) || (p.archived_at && p.archived_is_public === false);
        const owner = p.public_key ? ownerByPubkey.get(p.public_key) : null;
        providerInfo.set(p.id, {
            hidden,
            c0mpute_node: c0mputeNode,
            owner: owner ? personToken(owner) : null,
            provider: leaderboardToken(key, `provider:${p.id}`)
        });
    }
    const admins = new Set(adminIds.map(lower));

    const block = (since) => {
        const inWin = (r) => at(r) >= since;

        // Operators: settled credits, net of the house fee. No subsidies, no voids, no spend rows.
        const perProvider = new Map();
        // Models: every served job with a ledger row (subsidy included: it was served).
        const perModel = new Map();
        for (const e of earnings) {
            if (!inWin(e) || e.status === "void" || NOT_JOB_KINDS.includes(e.kind) || !e.provider_id) continue;
            const info = providerInfo.get(e.provider_id);
            if (!info || info.hidden) continue;
            if (e.model_name) {
                const m = perModel.get(e.model_name) ?? { model: e.model_name, jobs: 0, output_tokens: 0, users: new Set() };
                m.jobs += 1;
                m.output_tokens += Math.max(0, Number(e.output_tokens) || 0);
                if (e.billed) m.users.add(lower(e.billed));
                perModel.set(e.model_name, m);
            }
            if (e.kind === "subsidy") continue;
            const amount = Number(e.amount_usd) || 0;
            const p = perProvider.get(e.provider_id) ?? { ...info, earned_usd: 0, jobs: 0 };
            p.earned_usd += amount;
            p.jobs += 1;
            perProvider.set(e.provider_id, p);
        }

        // Customers: what accounts were actually charged. House accounts are not customers.
        const perSpender = new Map();
        for (const c of charges) {
            if (!inWin(c) || !c.user_id || admins.has(lower(c.user_id))) continue;
            const s = perSpender.get(lower(c.user_id)) ?? { who: personToken(c.user_id), spent_usd: 0, jobs: 0 };
            s.spent_usd += (Number(c.amount_micro) || 0) / 1e6;
            s.jobs += 1;
            perSpender.set(lower(c.user_id), s);
        }

        // Referrers: commissions earned (live rows) and nodes they brought in.
        const perReferrer = new Map();
        const ref = (id) => {
            const k = lower(id);
            if (!perReferrer.has(k)) perReferrer.set(k, { who: personToken(id), commissions_usd: 0, nodes: 0 });
            return perReferrer.get(k);
        };
        for (const c of commissions) {
            if (!inWin(c) || !c.referrer_user_id || c.status === "void" || c.status === "pending_approval") continue;
            ref(c.referrer_user_id).commissions_usd += Number(c.amount_usd) || 0;
        }
        for (const a of attributions) {
            if (!a?.referrer_user_id || (Date.parse(a.attributed_at ?? "") || 0) < since) continue;
            ref(a.referrer_user_id).nodes += 1;
        }

        const top = (arr, by) => arr.sort((a, b) => b[by] - a[by]).slice(0, limit);
        const spenders = [...perSpender.values()];
        return {
            providers: top(
                [...perProvider.values()]
                    .filter((p) => p.earned_usd > 0)
                    .map((p) => ({
                        ...(p.c0mpute_node ? { c0mpute_node: p.c0mpute_node } : {}),
                        owner: p.owner,
                        provider: p.provider,
                        earned_usd: roundUsd(p.earned_usd),
                        jobs: p.jobs
                    })),
                "earned_usd"
            ),
            spenders: top(spenders.map((s) => ({ ...s, spent_usd: roundUsd(s.spent_usd) })), "spent_usd"),
            referrers: top(
                [...perReferrer.values()]
                    .filter((r) => r.commissions_usd > 0 || r.nodes > 0)
                    .map((r) => ({ ...r, commissions_usd: roundUsd(r.commissions_usd) })),
                "commissions_usd"
            ),
            models: top(
                [...perModel.values()].map((m) => ({ model: m.model, jobs: m.jobs, output_tokens: m.output_tokens, users: m.users.size })),
                "jobs"
            ),
            totals: {
                spenders: spenders.length,
                spent_usd: roundUsd(spenders.reduce((a, s) => a + s.spent_usd, 0)),
                billed_jobs: spenders.reduce((a, s) => a + s.jobs, 0),
                earning_providers: perProvider.size,
                served_jobs: [...perModel.values()].reduce((a, m) => a + m.jobs, 0),
                output_tokens: [...perModel.values()].reduce((a, m) => a + m.output_tokens, 0)
            }
        };
    };

    const windows = {};
    for (const [k, ms] of Object.entries(LEADERBOARD_WINDOWS)) windows[k] = block(now - ms);
    windows.all = block(0);
    return { generated_at: new Date(now).toISOString(), currency: "USD", windows };
}
