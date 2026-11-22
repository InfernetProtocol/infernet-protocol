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
 * Every OTHER subject a trusted key sends (a CoinPay sub) is signed the same
 * way with that client's own secret (subjectSecretFor). While
 * INFERNET_REQUIRE_SIGNED_SUBJECTS is off (the default, a soak) an unsigned
 * one is still accepted and logged; once it is on, an unsigned or invalid
 * subject is ignored and the request is metered by address, never refused.
 *
 * A request id is accepted once (lib/data/subject-replay.js): a captured,
 * still-fresh signed request cannot be replayed.
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

/**
 * The signing secret for one trusted client (its label in
 * INFERNET_TRUSTED_CLIENT_KEYS): INFERNET_SUBJECT_SECRET_<LABEL> (upper case,
 * non-alphanumerics as _), else the secret of an origin that lists the client
 * (c0mpute-chat -> C0MPUTE_INFERNET_SUBJECT_SECRET). Null when none, or when
 * it is too short to be a real secret.
 */
export function subjectSecretFor(trustedName, env = process.env) {
    if (typeof trustedName !== "string" || !trustedName) return null;
    const own = env?.[`INFERNET_SUBJECT_SECRET_${trustedName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
    if (typeof own === "string" && own.length >= 32) return own;
    for (const cfg of Object.values(SIGNED_SUBJECT_ORIGINS)) {
        if (!originClients(cfg, env).includes(trustedName)) continue;
        const shared = env?.[cfg.secretEnv];
        if (typeof shared === "string" && shared.length >= 32) return shared;
    }
    return null;
}

/** INFERNET_REQUIRE_SIGNED_SUBJECTS: off (log-only) unless 1/true/yes/on. */
export function requireSignedSubjects(env = process.env) {
    return /^(1|true|yes|on)$/i.test(String(env?.INFERNET_REQUIRE_SIGNED_SUBJECTS ?? "").trim());
}

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
 * Check the signature on any billed subject from a trusted client. Never throws.
 * A `c0mpute:` (origin-minted) subject must also come from one of that
 * origin's clients.
 *
 * @returns {{ok: true, origin: string|null} | {ok: false, reason: string, origin?: string|null}}
 */
export function verifySubjectSignature({
    subject,
    ts,
    requestId,
    sig,
    trustedName,
    env = process.env,
    now = Date.now()
} = {}) {
    if (typeof subject !== "string" || subject.length === 0 || subject.length > 200) return { ok: false, reason: "bad_subject" };
    const minted = claimsSignedOrigin(subject);
    const origin = minted ? signedSubjectOrigin(subject) : null;
    if (minted && !origin) return { ok: false, reason: "bad_subject" };
    if (typeof sig !== "string" || sig.trim() === "") return { ok: false, reason: "unsigned", origin };
    // A short or missing secret is a misconfiguration, never "accept anything".
    const secret = minted ? originSecret(origin, env) : subjectSecretFor(trustedName, env);
    if (!secret) return { ok: false, reason: "not_configured", origin };
    if (minted && (typeof trustedName !== "string" || !originClients(SIGNED_SUBJECT_ORIGINS[origin], env).includes(trustedName))) {
        return { ok: false, reason: "wrong_client", origin };
    }
    const tsStr = typeof ts === "string" ? ts.trim() : "";
    if (!/^\d{1,12}$/.test(tsStr)) return { ok: false, reason: "bad_ts", origin };
    if (Math.abs(now - Number(tsStr) * 1000) > SIGNED_SUBJECT_MAX_SKEW_MS) return { ok: false, reason: "stale", origin };
    const rid = typeof requestId === "string" ? requestId.trim() : "";
    if (!REQUEST_ID.test(rid)) return { ok: false, reason: "bad_request_id", origin };
    const given = sig.trim().toLowerCase();
    if (!HEX_SIG.test(given)) return { ok: false, reason: "bad_sig", origin };
    const want = subjectSignature(secret, subject, tsStr, rid);
    const ok = timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(want, "hex"));
    return ok ? { ok: true, origin } : { ok: false, reason: "bad_sig", origin };
}

function originSecret(origin, env) {
    const v = env?.[SIGNED_SUBJECT_ORIGINS[origin]?.secretEnv];
    return typeof v === "string" && v.length >= 32 ? v : null;
}

/** verifySubjectSignature for an origin-minted (`c0mpute:`) subject only. */
export function verifySignedSubject(args = {}) {
    if (!signedSubjectOrigin(args.subject)) return { ok: false, reason: "not_signed_origin" };
    return verifySubjectSignature(args);
}

/**
 * Remember request ids for the signature window, so each is accepted once.
 * In-memory and bounded (oldest dropped first); `claim(key)` is true the first
 * time a key is seen within ttlMs, false on a replay. The TTL covers the whole
 * accepted window: a ts up to five minutes ahead stays valid for ten.
 */
export function createReplayCache({ ttlMs = 2 * SIGNED_SUBJECT_MAX_SKEW_MS + 60_000, max = 200_000, now = () => Date.now() } = {}) {
    const seen = new Map();
    return {
        claim(key) {
            const t = now();
            for (const [k, until] of seen) {
                if (until > t && seen.size < max) break;
                seen.delete(k);
            }
            const hit = seen.get(key);
            if (hit && hit > t) return false;
            seen.set(key, t + ttlMs);
            return true;
        },
        get size() {
            return seen.size;
        }
    };
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
