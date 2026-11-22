/**
 * Usage charges: bill a balance for metered work that is not inference, and
 * pay the node that did it. The pure half.
 *
 * c0mpute Live (p2p live streaming) meters relay bytes per node. The streamer
 * pays per GB from the same compute balance chat is charged to; the node that
 * relayed keeps its share and the house keeps the same fee as on inference
 * (interactive_billing.house_fee_pct, 5%), out of which a referrer is paid.
 *
 * Nothing here is a second ledger. One usage charge is recorded exactly like
 * one billed chat job:
 *
 *   jobs               one row, type "usage", model_name = the kind
 *   billing_ledger     one 'charge', idem key job:<id>:charge (chargeIdemKey)
 *   provider_earnings  one 'paid' row on the node's provider (c0mpute:<peer>),
 *                      written by creditProvidersFromCharge
 *
 * so the platform_fee and referral-commission triggers, payouts, the
 * leaderboard and every earnings view pick it up with no change. The two
 * differences from chat: the caller states the amount (there are no tokens to
 * price), and the charge is all or nothing (billing_charge_exact), because a
 * capped charge would short the node.
 */

import { createHash } from "node:crypto";
import { MICRO, numericUsdToMicro } from "./core.js";
import { chargeIdemKey } from "./interactive.js";

/** What may be billed this way. The kind is the row's label in every view. */
export const USAGE_KINDS = Object.freeze(["live.relay"]);

export const USAGE_KIND_LABELS = Object.freeze({
    "live.relay": "live relay"
});

/**
 * The label of a usage job from its title ("usage:live.relay" -> "Live
 * relay"), or null for any other job. For views that list earnings by job.
 */
export function usageKindLabel(title) {
    const m = /^usage:(.+)$/.exec(String(title ?? ""));
    if (!m) return null;
    const label = USAGE_KIND_LABELS[m[1]] ?? m[1];
    return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Most one call may charge, in USD. A meter bug must not empty a balance. */
export const MAX_USAGE_CHARGE_USD = 50;

/** jobs.type of a usage charge, so chat job lists (type "chat") leave it out. */
export const USAGE_JOB_TYPE = "usage";

/** provider_earnings.metadata.source of a usage credit ("interactive" for chat). */
export const USAGE_SOURCE = "usage";

const MAX_IDEM_KEY = 200;
const MAX_META_CHARS = 2000;
// A libp2p peer id (base58), the same shape lib/data/chat-c0mpute.js accepts.
const C0MPUTE_PROVIDER = /^c0mpute:([1-9A-HJ-NP-Za-km-z]{32,64})$/;

function bad(error) {
    return { ok: false, status: 400, error };
}

/**
 * Validate a usage-charge body.
 * Returns { ok, value: { idemKey, kind, costMicro, provider, peerId, meta } }
 * or { ok: false, status: 400, error }.
 */
export function validateUsageCharge(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return bad("a JSON object is required");

    const idemKey = typeof body.idem_key === "string" ? body.idem_key.trim() : "";
    if (!idemKey || idemKey.length > MAX_IDEM_KEY || !/^[\x21-\x7e]+$/.test(idemKey)) {
        return bad(`idem_key is required: 1 to ${MAX_IDEM_KEY} printable characters, no spaces`);
    }

    if (!USAGE_KINDS.includes(body.kind)) {
        return bad(`unknown kind; one of: ${USAGE_KINDS.join(", ")}`);
    }

    // A number, not a numeric string: "1e3" or "5,00" must not become money.
    const cost = body.cost_usd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
        return bad("cost_usd must be a positive, finite number");
    }
    if (cost > MAX_USAGE_CHARGE_USD) {
        return bad(`cost_usd is over the ${MAX_USAGE_CHARGE_USD} USD limit for one call`);
    }
    // The ledger is integer micro-USD. Rounded to the nearest; the response
    // reports what was actually charged.
    const costMicro = Math.round(cost * MICRO);
    if (costMicro < 1) {
        return bad("cost_usd is under one micro-dollar (0.000001); accumulate usage and charge a larger amount");
    }

    const m = C0MPUTE_PROVIDER.exec(typeof body.provider === "string" ? body.provider : "");
    if (!m) return bad('provider must be "c0mpute:<peer_id>"');

    let meta = null;
    if (body.meta != null) {
        if (typeof body.meta !== "object" || Array.isArray(body.meta)) return bad("meta must be an object");
        let text;
        try {
            text = JSON.stringify(body.meta);
        } catch {
            return bad("meta must be JSON");
        }
        if (text.length > MAX_META_CHARS) return bad(`meta is over ${MAX_META_CHARS} characters`);
        meta = JSON.parse(text);
    }

    return { ok: true, value: { idemKey, kind: body.kind, costMicro, provider: m[0], peerId: m[1], meta } };
}

/**
 * The jobs.id of a usage charge: a UUID derived from the calling client and
 * its idem key, so the same call always lands on the same job, ledger key
 * (chargeIdemKey) and earnings row. Scoped by client so two trusted clients
 * cannot collide on a key.
 */
export function usageJobId(client, idemKey) {
    const h = createHash("sha256").update(`usage-charge\n${client}\n${idemKey}`).digest("hex");
    const variant = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function usd(micro) {
    return (Number(micro) || 0) / MICRO;
}

function withStatus(message, status, extra = {}) {
    return Object.assign(new Error(message), { status, ...extra });
}

/**
 * Charge one usage amount to `userId` and credit the node, once.
 *
 * `store` is the database (lib/data/usage-charge.js; a fake in tests):
 *   providerId(peerId)                    the node's providers row id
 *   charge({ userId, idem, costMicro, allowEarned, jobId })
 *                                         billing_charge_exact
 *   job(jobId)                            the usage job row, or null
 *   ensureJob(row)                        insert it unless it exists
 *   credit({ job, chargeMicro, feePct, kind })
 *                                         creditProvidersFromCharge
 *   earning(jobId, providerId)            the 'paid' row, or null
 *
 * Returns the response body. Throws an Error with `.status` for a conflict
 * (409, the idem key was used for a different charge) or a failure after the
 * charge (500); the latter is safe to retry with the same idem key, which
 * finishes the credit and never charges twice.
 */
export async function chargeUsage({ input, userId, client, store, feePct, allowEarned = true, now = () => new Date() }) {
    const jobId = usageJobId(client, input.idemKey);
    const providerId = await store.providerId(input.peerId);
    if (!providerId) throw withStatus("could not open a provider for that node; try again", 503);

    const out = await store.charge({
        userId,
        idem: chargeIdemKey(jobId),
        costMicro: input.costMicro,
        allowEarned,
        jobId
    });
    const replay = out?.reason === "already_charged";
    if (!out?.charged && !replay) {
        // billing_charge_exact moved nothing.
        return { charged: false, reason: "insufficient_balance", balance_usd: usd(out?.spendable_micro) };
    }

    const chargedMicro = Number(out.charged_micro) || 0;
    const existing = await store.job(jobId);
    if (replay) {
        // The key is the record of one charge. The same key for another
        // person, amount, node or kind is a caller bug, never a new charge.
        const same = String(out.user_id ?? userId) === String(userId)
            && chargedMicro === input.costMicro
            && (!existing || (existing.provider_id === providerId && existing.model_name === input.kind));
        if (!same) {
            throw withStatus("idem_key was already used for a different charge", 409, { code: "idem_key_reused" });
        }
    }

    const at = now().toISOString();
    const job = { id: jobId, provider_id: providerId, model_name: input.kind, billed_user_id: userId };
    if (!existing) {
        await store.ensureJob({
            ...job,
            title: `${USAGE_SOURCE}:${input.kind}`,
            type: USAGE_JOB_TYPE,
            status: "completed",
            payment_offer: 0,
            assigned_at: at,
            completed_at: at,
            updated_at: at,
            input_spec: {
                billing: "usage_charge",
                kind: input.kind,
                idem_key: input.idemKey,
                client,
                provider: input.provider,
                cost_micro: chargedMicro,
                ...(input.meta ? { meta: input.meta } : {})
            }
        });
    }

    // Idempotent on (job, provider): a replay finds the row already there.
    await store.credit({ job, chargeMicro: chargedMicro, feePct, kind: input.kind });
    const earning = await store.earning(jobId, providerId);
    if (!earning) {
        throw withStatus("charged, but the node credit is not recorded yet; retry with the same idem_key", 500, {
            code: "credit_pending"
        });
    }

    // From the stored row, so a replay reports the split the charge was
    // actually made at, whatever the fee is today.
    return {
        charged: true,
        cost_usd: usd(numericUsdToMicro(earning.gross_usd)),
        operator_usd: usd(numericUsdToMicro(earning.amount_usd)),
        fee_usd: usd(numericUsdToMicro(earning.fee_usd)),
        balance_usd: usd(out.spendable_micro)
    };
}
