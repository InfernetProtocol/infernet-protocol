/**
 * Consumer credit codes + scarce invites: pure rules, no I/O (tested in
 * tests/credits-core.test.js). The server side lives in ./index.js.
 *
 * What a credit is: one unit of the CONSUMER compute-credit balance of a
 * signed-in account (credit_ledger, unit "credits"). It is never provider
 * earnings and can never be withdrawn: provider_earnings / payout_requests
 * are a different ledger that this code does not touch.
 */

export const CREDIT_UNIT = "credits";

/** Invites every account may create (admins can raise one user's). */
export const INVITE_QUOTA = 3;
/** Invite codes expire after this many days. */
export const INVITE_TTL_DAYS = 30;
/** An account can hand out invites once it is this old (stops sock-puppet chains). */
export const INVITE_MIN_INVITER_AGE_DAYS = 7;
/** Only accounts at most this old can accept an invite: invites are for new people. */
export const INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS = 7;
/** Most inviter-side bonuses one account gets in 30 days (both sides are refused past it). */
export const INVITE_BONUS_MONTHLY_CAP = 10;
/** Default credits each side gets for a qualifying invite (INFERNET_INVITE_BONUS_CREDITS overrides). */
export const DEFAULT_INVITE_BONUS_CREDITS = 100;
/** Cookie /i/<code> sets so the code survives the trip through signup. */
export const INVITE_COOKIE = "infernet_invite";
/** Cookie that carries a just-created invite code to /invites once (never in the URL). */
export const FLASH_COOKIE = "infernet_new_invite";
/** Largest single code an admin can mint. */
export const MAX_MINT_CREDITS = 1_000_000;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Read env by a computed name so Next.js cannot inline it at build time. */
export function envValue(name) {
    const env = process.env;
    return env[name];
}

export function inviteBonusCredits() {
    const n = Number(envValue("INFERNET_INVITE_BONUS_CREDITS"));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_INVITE_BONUS_CREDITS;
}

export const REDEEM_MESSAGES = {
    invalid: "That code is not valid. Check it and try again.",
    expired: "That code has expired.",
    used_up: "That code has already been used.",
    already_redeemed: "You have already redeemed that code.",
    revoked: "That code is no longer valid."
};

export const ACCEPT_MESSAGES = {
    invalid: "That invite code is not valid.",
    expired: "That invite has expired.",
    used: "That invite has already been used.",
    self: "You cannot use your own invite.",
    revoked: "That invite was withdrawn.",
    already_invited: "Your account has already joined on an invite.",
    not_new: `Invites are for new accounts (${INVITE_ACCEPT_MAX_ACCOUNT_AGE_DAYS} days old or less).`,
    no_user: "Account not found."
};

/** Throwaway / disposable mail hosts: an invite from or to one earns no bonus. */
export const THROWAWAY_DOMAINS = new Set([
    "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "sharklasers.com",
    "grr.la", "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org", "temp-mail.io",
    "throwawaymail.com", "yopmail.com", "yopmail.net", "getnada.com", "nada.email", "dispostable.com",
    "trashmail.com", "trashmail.de", "mailnesia.com", "maildrop.cc", "mintemail.com", "mohmal.com",
    "fakeinbox.com", "emailondeck.com", "tempinbox.com", "spamgourmet.com", "mailcatch.com",
    "moakt.com", "tempr.email", "discard.email", "inboxkitten.com", "burnermail.io", "33mail.com",
    "1secmail.com", "1secmail.net", "1secmail.org", "mail.tm", "mail.gw", "tmpmail.org", "tmpmail.net",
    "emailfake.com", "fakemail.net", "spambox.us", "mytemp.email", "tempmailo.com", "minuteinbox.com"
]);

function splitEmail(email) {
    if (!email || typeof email !== "string") return null;
    const e = email.trim().toLowerCase();
    const at = e.lastIndexOf("@");
    if (at <= 0 || at === e.length - 1) return null;
    return { local: e.slice(0, at), domain: e.slice(at + 1) };
}

/**
 * One mailbox, however it is spelled: lowercased, `+tag` dropped, and for
 * Gmail the dots too (googlemail.com is gmail.com).
 */
export function mailboxKey(email) {
    const parts = splitEmail(email);
    if (!parts) return null;
    let { local, domain } = parts;
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    if (domain === "googlemail.com") domain = "gmail.com";
    if (domain === "gmail.com") local = local.replace(/\./g, "");
    return `${local}@${domain}`;
}

export function isThrowawayEmail(email) {
    const parts = splitEmail(email);
    if (!parts) return false;
    const d = parts.domain;
    for (const t of THROWAWAY_DOMAINS) {
        if (d === t || d.endsWith(`.${t}`)) return true;
    }
    return false;
}

export function ageDays(createdAt, now) {
    if (!createdAt) return 0;
    const t = new Date(createdAt).getTime();
    return Number.isFinite(t) ? (now - t) / DAY_MS : 0;
}

/**
 * Decide whether a used invite earns the bonus. Returns null (grant) or a
 * reason string. `inviterBonuses30d` is how many inviter-side bonuses the
 * inviter was granted in the last 30 days.
 */
export function bonusDenyReason({ invitee, inviter, inviterBonuses30d }) {
    if (!invitee?.email || !inviter?.email) return "unknown_account";
    const a = mailboxKey(invitee.email);
    if (a && a === mailboxKey(inviter.email)) return "same_mailbox";
    if (isThrowawayEmail(invitee.email) || isThrowawayEmail(inviter.email)) return "throwaway_domain";
    if (inviterBonuses30d >= INVITE_BONUS_MONTHLY_CAP) return "monthly_cap";
    return null;
}

/** Status shown for one invite row. */
export function inviteStatus(i, now) {
    if (i.usedBy) return "used";
    if (i.revokedAt) return "revoked";
    if (i.expiresAt !== null && i.expiresAt !== undefined && now >= i.expiresAt) return "expired";
    return "open";
}

/** Validate an admin mint request; returns { ok, value } or { ok:false, error }. */
export function parseMintInput(body = {}) {
    const credits = Number(body.credits ?? body.amount);
    if (!Number.isInteger(credits) || credits < 1 || credits > MAX_MINT_CREDITS) {
        return { ok: false, error: `credits must be a whole number from 1 to ${MAX_MINT_CREDITS}` };
    }
    const max = body.max_redemptions ?? body.maxRedemptions ?? 1;
    const maxRedemptions = Number(max);
    if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 10_000) {
        return { ok: false, error: "max_redemptions must be a whole number from 1 to 10000" };
    }
    let expiresAt = null;
    const rawExp = body.expires_at ?? body.expiresAt ?? null;
    if (rawExp !== null && rawExp !== undefined && rawExp !== "") {
        const t = typeof rawExp === "number" ? rawExp : Date.parse(String(rawExp));
        if (!Number.isFinite(t)) return { ok: false, error: "expires_at must be an ISO date or ms timestamp" };
        expiresAt = t;
    }
    const monthly = body.monthly === true || body.every === "month";
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 200) : null;
    return {
        ok: true,
        value: {
            grant: { unit: CREDIT_UNIT, amount: credits, ...(monthly ? { every: "month" } : {}) },
            label: label ?? `${credits} Infernet compute credits${monthly ? " a month" : ""}`,
            maxRedemptions,
            expiresAt
        }
    };
}

/** Public origin for links: NEXT_PUBLIC_APP_URL unless it is localhost, else the request host. */
export function publicOrigin(request) {
    const configured = envValue("NEXT_PUBLIC_APP_URL");
    if (configured && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(configured)) return configured.replace(/\/+$/, "");
    const h = request?.headers;
    const host = h?.get?.("x-forwarded-host") ?? h?.get?.("host");
    const proto = h?.get?.("x-forwarded-proto") ?? "https";
    if (host && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/.test(host)) return `${proto.split(",")[0]}://${host.split(",")[0]}`;
    return "https://infernetprotocol.com";
}

export function inviteUrl(origin, code) {
    return `${origin.replace(/\/+$/, "")}/i/${encodeURIComponent(code)}`;
}

export function refUrl(origin, code) {
    return `${origin.replace(/\/+$/, "")}/?ref=${encodeURIComponent(code)}`;
}

/** Light shape check before a code touches the database. */
export function looksLikeCode(code) {
    return typeof code === "string" && code.replace(/[\s-]/g, "").length >= 8 && code.length <= 64;
}
