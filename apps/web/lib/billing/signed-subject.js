import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed billed subjects: a trusted client naming one of ITS OWN users, who has
 * no CoinPay identity at all, so the free tier is metered per person instead
 * of per the client's server IP.
 *
 * The bug this closes (2026-11-22): c0mpute.com sent no
 * X-Infernet-Billed-Subject for a passkey/password-only account, so every such
 * person reached us as c0mpute's server address and they all shared ONE ten a
 * day allowance. New signups hit "free daily limit reached" on their first
 * message.
 *
 * A client-minted subject (`c0mpute:<user id>`) is worth free compute, so it
 * is not taken on the trusted key alone. It must also carry
 *
 *   x-infernet-subject-ts    unix seconds, within five minutes of our clock
 *   x-infernet-request-id    a per-call random id (8-128 of [A-Za-z0-9_-])
 *   x-infernet-subject-sig   hex HMAC-SHA256(secret, "<subject>|<ts>|<request id>")
 *
 * with a secret shared only with that client (C0MPUTE_INFERNET_SUBJECT_SECRET,
 * in both apps' logicsrc vaults), and arrive on a trusted key whose label is
 * one of that origin's clients. Anything less and the subject is ignored: the
 * request is metered by address exactly as before.
 *
 * In case the secret leaks, everything one origin's signed subjects spend for
 * free is also capped per day (DEFAULT_ORIGIN_FREE_CEILING), so a leak costs
 * at most that many free queries rather than an unlimited supply of fresh
 * allowances.
 *
 * Plain CoinPay subjects (no origin prefix) are unchanged: they resolve
 * through coinpay_identities as before and need no signature.
 */

export const SIGNED_SUBJECT_MAX_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_ORIGIN_FREE_CEILING = 5000;
/** Log once the origin has spent this share of its daily ceiling. */
export const ORIGIN_CEILING_WARN_AT = 0.8;

/**
 * Clients allowed to mint subjects, by subject prefix. `clients` are the
 * labels in INFERNET_TRUSTED_CLIENT_KEYS whose key may present them
 * (overridable with clientsEnv, comma-separated).
 */
export const SIGNED_SUBJECT_ORIGINS = Object.freeze({
    c0mpute: Object.freeze({
        secretEnv: "C0MPUTE_INFERNET_SUBJECT_SECRET",
        clientsEnv: "C0MPUTE_INFERNET_SUBJECT_CLIENTS",
        clients: Object.freeze(["c0mpute-chat"]),
        ceilingEnv: "C0MPUTE_INFERNET_FREE_CEILING"
    })
});

const SUBJECT_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const HEX_SIG = /^[0-9a-f]{64}$/;

/** The origin a subject claims (`c0mpute:<id>` -> "c0mpute"), or null for any other subject. */
export function signedSubjectOrigin(subject) {
    if (typeof subject !== "string") return null;
    const cut = subject.indexOf(":");
    if (cut <= 0) return null;
    const origin = subject.slice(0, cut);
    if (!Object.hasOwn(SIGNED_SUBJECT_ORIGINS, origin)) return null;
    return SUBJECT_ID.test(subject.slice(cut + 1)) ? origin : null;
}

/** True when the subject carries an origin prefix at all (signed or not). */
export function claimsSignedOrigin(subject) {
    if (typeof subject !== "string") return false;
    const cut = subject.indexOf(":");
    return cut > 0 && Object.hasOwn(SIGNED_SUBJECT_ORIGINS, subject.slice(0, cut));
}

/** hex HMAC-SHA256 over "<subject>|<ts>|<request id>". */
export function subjectSignature(secret, subject, ts, requestId) {
    return createHmac("sha256", String(secret)).update(`${subject}|${ts}|${requestId}`).digest("hex");
}

function originClients(cfg, env) {
    const raw = env?.[cfg.clientsEnv];
    if (typeof raw === "string" && raw.trim()) {
        return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return cfg.clients;
}

/**
 * Check a signed subject. Never throws.
 *
 * @returns {{ok: true, origin: string} | {ok: false, reason: string, origin?: string}}
 */
export function verifySignedSubject({
    subject,
    ts,
    requestId,
    sig,
    trustedName,
    env = process.env,
    now = Date.now()
} = {}) {
    const origin = signedSubjectOrigin(subject);
    if (!origin) return { ok: false, reason: "not_signed_origin" };
    const cfg = SIGNED_SUBJECT_ORIGINS[origin];
    const secret = env?.[cfg.secretEnv];
    // A short or missing secret is a misconfiguration, never "accept anything".
    if (typeof secret !== "string" || secret.length < 32) return { ok: false, reason: "not_configured", origin };
    if (typeof trustedName !== "string" || !originClients(cfg, env).includes(trustedName)) {
        return { ok: false, reason: "wrong_client", origin };
    }
    const tsStr = typeof ts === "string" ? ts.trim() : "";
    if (!/^\d{1,12}$/.test(tsStr)) return { ok: false, reason: "bad_ts", origin };
    if (Math.abs(now - Number(tsStr) * 1000) > SIGNED_SUBJECT_MAX_SKEW_MS) return { ok: false, reason: "stale", origin };
    const rid = typeof requestId === "string" ? requestId.trim() : "";
    if (!REQUEST_ID.test(rid)) return { ok: false, reason: "bad_request_id", origin };
    const given = typeof sig === "string" ? sig.trim().toLowerCase() : "";
    if (!HEX_SIG.test(given)) return { ok: false, reason: "bad_sig", origin };
    const want = subjectSignature(secret, subject, tsStr, rid);
    const ok = timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(want, "hex"));
    return ok ? { ok: true, origin } : { ok: false, reason: "bad_sig", origin };
}

/** Today's free-query ceiling for everything one origin's signed subjects spend. */
export function originFreeCeiling(origin, env = process.env) {
    const cfg = SIGNED_SUBJECT_ORIGINS[origin];
    if (!cfg) return 0;
    const n = Number.parseInt(String(env?.[cfg.ceilingEnv] ?? ""), 10);
    return Number.isInteger(n) && n >= 0 && n <= 10_000_000 ? n : DEFAULT_ORIGIN_FREE_CEILING;
}

/** The free_queries counter key for an origin's ceiling. */
export function originCounterSubject(origin) {
    return `origin:${origin}`;
}

/** A short, log-safe form of a subject (the id is opaque, but keep lines bounded). */
export function logSubject(subject) {
    const s = String(subject ?? "");
    return s.length > 48 ? `${s.slice(0, 45)}...` : s;
}
