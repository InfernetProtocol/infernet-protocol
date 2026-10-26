import "server-only";
import { Credits, supabaseStore as creditStore } from "@profullstack/redeem-credits";
import { Affiliates, supabaseStore as affiliateStore } from "@profullstack/affiliates";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
    CREDIT_UNIT,
    INVITE_QUOTA,
    INVITE_TTL_DAYS,
    INVITE_MIN_INVITER_AGE_DAYS,
    INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS,
    DAY_MS,
    REDEEM_MESSAGES,
    ACCEPT_MESSAGES,
    ageDays,
    bonusDenyReason,
    inviteBonusCredits,
    inviteStatus,
    looksLikeCode
} from "./core.js";

/**
 * Consumer credit codes + scarce invites (server only).
 *
 * - A credit code (@profullstack/redeem-credits, CR-XXXX-XXXX-XXXX-XXXX)
 *   adds compute credits to the CONSUMER balance of a signed-in account:
 *   credit_ledger, unit "credits". Infernet had no consumer balance before
 *   (jobs are free and IP-limited, or paid per job through CoinPay), so this
 *   ledger IS the balance; there is nothing to mirror into. It is never
 *   provider_earnings and nothing can withdraw it.
 * - An invite (@profullstack/affiliates, INV-XXXX-XXXX-XXXX): INVITE_QUOTA per
 *   account. When a NEW account joins on one and confirms its email, both
 *   people get inviteBonusCredits() credits, unless it is the same mailbox, a
 *   throwaway domain, or the inviter hit the monthly cap. Each side is decided
 *   once in invite_bonuses (claimed before the grant), and a unique index on
 *   credit_ledger (user_id, source) for invite sources backs that up.
 * - The open affiliate link is aff.affiliateCode() as ?ref=; proxy.js keeps
 *   first touch in the referral_code cookie and sign-in records it with
 *   aff.attribute(). Infernet has no other referral program.
 *
 * Built lazily so env is read at runtime, not inlined at build.
 */

export function buildCreditDeps(db, now = Date.now) {
    const credits = new Credits(creditStore(db), { now });
    const affiliates = new Affiliates(affiliateStore(db), {
        now,
        defaultQuota: INVITE_QUOTA,
        inviteTtlMs: INVITE_TTL_DAYS * DAY_MS
    });
    return { db, credits, affiliates, now };
}

let deps;
export function getCreditDeps() {
    return (deps ??= buildCreditDeps(getSupabaseServerClient()));
}

/** Test hook. */
export function setCreditDepsForTest(next) {
    deps = next;
}

// ── Balance + codes ───────────────────────────────────────────────────

export async function creditSummary(userId, d = getCreditDeps()) {
    const [balance, history] = await Promise.all([
        d.credits.balance(userId, CREDIT_UNIT),
        d.credits.history(userId, CREDIT_UNIT)
    ]);
    return {
        unit: CREDIT_UNIT,
        balance,
        history: history
            .slice(-50)
            .reverse()
            .map((h) => ({ amount: h.amount, kind: h.kind, source: describeSource(h.source), at: new Date(h.at).toISOString() }))
    };
}

function describeSource(source) {
    if (!source) return "grant";
    if (source.startsWith("code:")) return "credit code";
    if (source.startsWith("invite:")) return source.endsWith(":inviter") ? "invite bonus (you invited)" : "invite bonus (you joined)";
    if (source === "admin") return "admin grant";
    return source;
}

export async function redeemCreditCode(userId, code, d = getCreditDeps()) {
    if (!looksLikeCode(code)) return { ok: false, reason: "invalid", message: REDEEM_MESSAGES.invalid };
    const r = await d.credits.redeem(code, userId);
    if (!r.ok) return { ok: false, reason: r.reason, message: REDEEM_MESSAGES[r.reason] ?? r.reason };
    return {
        ok: true,
        credits: r.grant.amount,
        monthly: r.grant.every === "month",
        balance: await d.credits.balance(userId, CREDIT_UNIT)
    };
}

export async function mintCreditCode(input, createdBy, d = getCreditDeps()) {
    return d.credits.mint({ ...input, ...(createdBy ? { createdBy } : {}) });
}

// ── Invites ───────────────────────────────────────────────────────────

export class InviteError extends Error {
    constructor(message, status, reason) {
        super(message);
        this.status = status;
        this.reason = reason;
    }
}

async function authUser(db, userId) {
    try {
        const { data, error } = await db.auth.admin.getUserById(userId);
        if (error || !data?.user) return null;
        const u = data.user;
        return {
            id: u.id,
            email: u.email ?? null,
            confirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at),
            createdAt: u.created_at ?? null
        };
    } catch {
        return null;
    }
}

async function bonusRows(db, inviteIds) {
    if (!inviteIds.length) return [];
    const { data } = await db
        .from("invite_bonuses")
        .select("invite_id, side, user_id, outcome, reason, credits, created_at")
        .in("invite_id", inviteIds);
    return data ?? [];
}

export async function inviteOverview(userId, d = getCreditDeps()) {
    const now = d.now();
    const [quota, raw, me] = await Promise.all([
        d.affiliates.quota(userId),
        d.affiliates.invites(userId),
        authUser(d.db, userId)
    ]);
    const bonuses = await bonusRows(d.db, raw.filter((i) => i.usedBy).map((i) => i.id));
    const invites = raw.map((i) => {
        const mine = bonuses.find((b) => b.invite_id === i.id && b.side === "inviter");
        return {
            id: i.id,
            note: i.note,
            createdAt: new Date(i.createdAt).toISOString(),
            expiresAt: i.expiresAt ? new Date(i.expiresAt).toISOString() : null,
            usedAt: i.usedAt ? new Date(i.usedAt).toISOString() : null,
            status: inviteStatus(i, now),
            ...(i.usedBy ? { bonus: mine ? mine.outcome : "pending", ...(mine?.reason ? { bonusReason: mine.reason } : {}) } : {})
        };
    });
    const canInvite = ageDays(me?.createdAt, now) >= INVITE_MIN_INVITER_AGE_DAYS;
    return {
        quota,
        invites,
        canInvite,
        unlocksAt:
            !canInvite && me?.createdAt
                ? new Date(new Date(me.createdAt).getTime() + INVITE_MIN_INVITER_AGE_DAYS * DAY_MS).toISOString()
                : null,
        bonusCredits: inviteBonusCredits(),
        affiliateCode: await d.affiliates.affiliateCode(userId)
    };
}

export async function createInvite(userId, note = "", d = getCreditDeps()) {
    const me = await authUser(d.db, userId);
    if (!me) throw new InviteError("Account not found.", 404, "no_user");
    if (ageDays(me.createdAt, d.now()) < INVITE_MIN_INVITER_AGE_DAYS) {
        throw new InviteError(`Invites unlock once your account is ${INVITE_MIN_INVITER_AGE_DAYS} days old.`, 403, "too_new");
    }
    try {
        return await d.affiliates.createInvite(userId, String(note ?? "").slice(0, 200));
    } catch (err) {
        if (/no invites left/i.test(err?.message ?? "")) throw new InviteError("You have no invites left.", 409, "no_invites_left");
        throw err;
    }
}

export async function revokeInvite(userId, inviteId, d = getCreditDeps()) {
    const mine = (await d.affiliates.invites(userId)).find((i) => i.id === inviteId);
    if (!mine) throw new InviteError("Invite not found.", 404, "not_found");
    if (mine.usedBy) throw new InviteError("That invite has already been used.", 409, "used");
    await d.affiliates.revokeInvite(inviteId);
}

/** Spend an invite on a new account, then settle the bonus. */
export async function acceptInvite(userId, code, d = getCreditDeps()) {
    const fail = (reason) => ({ ok: false, reason, message: ACCEPT_MESSAGES[reason] ?? reason });
    if (!looksLikeCode(code)) return fail("invalid");
    const me = await authUser(d.db, userId);
    if (!me) return fail("no_user");
    if (ageDays(me.createdAt, d.now()) > INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS) return fail("not_new");
    if (await d.affiliates.invitedBy(userId)) return fail("already_invited");

    const r = await d.affiliates.redeemInvite(code, userId);
    if (!r.ok) return fail(r.reason);

    const settled = await settleInviteBonus(userId, d);
    return {
        ok: true,
        inviteId: r.inviteId,
        bonus: settled.status === "granted" || settled.status === "already" ? "granted" : settled.status === "denied" ? "denied" : "pending",
        bonusCredits: inviteBonusCredits()
    };
}

/** Claim one (invite, side) decision; false when one is already recorded. */
async function claim(db, row) {
    const { data, error } = await db
        .from("invite_bonuses")
        .upsert(row, { onConflict: "invite_id,side", ignoreDuplicates: true })
        .select("invite_id");
    if (error) throw new Error(`invite_bonuses: ${error.message}`);
    return (data ?? []).length > 0;
}

async function unclaim(db, inviteId, side) {
    await db.from("invite_bonuses").delete().eq("invite_id", inviteId).eq("side", side);
}

async function grantSide(d, inviteId, side, userId, amount) {
    const won = await claim(d.db, { invite_id: inviteId, side, user_id: userId, outcome: "granted", reason: null, credits: amount });
    if (!won) return false;
    if (amount <= 0) return true;
    try {
        await d.credits.grant(userId, { unit: CREDIT_UNIT, amount }, `invite:${inviteId}:${side}`);
    } catch (err) {
        // credit_ledger_invite_once: it is already in the ledger, keep the claim.
        if (/duplicate key|credit_ledger_invite_once|23505/i.test(err?.message ?? "")) return false;
        await unclaim(d.db, inviteId, side); // nothing was granted; a later settle retries
        throw err;
    }
    return true;
}

async function inviterBonusesLast30Days(d, inviterId) {
    const since = new Date(d.now() - 30 * DAY_MS).toISOString();
    const { data } = await d.db
        .from("invite_bonuses")
        .select("invite_id")
        .eq("user_id", inviterId)
        .eq("side", "inviter")
        .eq("outcome", "granted")
        .gte("created_at", since);
    return (data ?? []).length;
}

/**
 * Grant the invite bonus to both sides if the invited account qualifies now.
 * Idempotent: each side is decided once per invite. Safe to call often.
 */
export async function settleInviteBonus(inviteeId, d = getCreditDeps()) {
    const inviterId = await d.affiliates.invitedBy(inviteeId);
    if (!inviterId) return { status: "none" };
    const invite = (await d.affiliates.invites(inviterId)).find((i) => i.usedBy === inviteeId);
    if (!invite) return { status: "none" };

    const existing = await bonusRows(d.db, [invite.id]);
    if (existing.length >= 2) {
        const denied = existing.find((b) => b.outcome === "denied");
        return denied ? { status: "denied", reason: denied.reason ?? "denied" } : { status: "already", inviteId: invite.id };
    }

    const [invitee, inviter] = await Promise.all([authUser(d.db, inviteeId), authUser(d.db, inviterId)]);
    if (!invitee?.confirmed) return { status: "pending", reason: "email not confirmed" };

    const deny = bonusDenyReason({ invitee, inviter, inviterBonuses30d: await inviterBonusesLast30Days(d, inviterId) });
    if (deny) {
        for (const [side, uid] of [["invitee", inviteeId], ["inviter", inviterId]]) {
            await claim(d.db, { invite_id: invite.id, side, user_id: uid, outcome: "denied", reason: deny, credits: 0 });
        }
        console.warn("[invites] bonus denied", { inviteId: invite.id, deny });
        return { status: "denied", reason: deny };
    }

    const amount = inviteBonusCredits();
    const a = await grantSide(d, invite.id, "invitee", inviteeId, amount);
    const b = await grantSide(d, invite.id, "inviter", inviterId, amount);
    return { status: a || b ? "granted" : "already", inviteId: invite.id };
}

/** Settle every used invite this user sent (at most the quota). */
export async function settleInvitesSentBy(inviterId, d = getCreditDeps()) {
    for (const inv of await d.affiliates.invites(inviterId)) {
        if (!inv.usedBy) continue;
        try {
            await settleInviteBonus(inv.usedBy, d);
        } catch (err) {
            console.error("[invites] settle failed", { inviteId: inv.id, err: err?.message ?? err });
        }
    }
}

/**
 * After a sign-in (password, magic link or email confirmation): record a
 * ?ref= attribution, accept a pending invite (cookie or the code stored in
 * user_metadata at signup), then settle any bonus. Never throws: signing in
 * must not fail on an invite.
 */
export async function onSignedIn(userId, { inviteCode = null, refCode = null } = {}, d = getCreditDeps()) {
    const out = {};
    try {
        if (refCode) await d.affiliates.attribute(String(refCode), userId);
    } catch (err) {
        console.error("[affiliates] attribute failed", err?.message ?? err);
    }
    try {
        if (inviteCode && !(await d.affiliates.invitedBy(userId))) {
            out.invite = await acceptInvite(userId, String(inviteCode), d);
        } else {
            out.settled = await settleInviteBonus(userId, d);
        }
    } catch (err) {
        console.error("[invites] sign-in settle failed", err?.message ?? err);
    }
    return out;
}
