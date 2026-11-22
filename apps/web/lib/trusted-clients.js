import { createHash } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";
import { claimsSignedOrigin, logSubject, requireSignedSubjects, verifySubjectSignature } from "@/lib/billing/signed-subject";

/**
 * Trusted clients: our own apps calling the open-market chat API.
 *
 * The public playground limit (20 requests an hour per IP) is right for
 * strangers and wrong for a product of ours that sends all its model calls
 * through c0mpute (OutreachGraph, 2026-11-02, hit it within minutes). A
 * trusted client presents `Authorization: Bearer ifc_...`; the server keeps
 * only SHA-256 hashes of the keys, in `INFERNET_TRUSTED_CLIENT_KEYS`
 * (comma-separated hex, `name:hash` to label one). A trusted key gets its own
 * hourly budget (`INFERNET_TRUSTED_CLIENT_RPH`, default 2000) instead of the
 * per-IP one. It still routes on the open market; nothing else changes.
 *
 * Mint a key: `node -e "const k='ifc_'+require('crypto').randomBytes(24).toString('hex');
 *   console.log(k, require('crypto').createHash('sha256').update(k).digest('hex'))"`
 */

export const TRUSTED_KEY_PREFIX = "ifc_";

export function hashKey(key) {
    return createHash("sha256").update(String(key)).digest("hex");
}

/** `{hash -> name}` from the env list. */
export function trustedKeyHashes(raw = process.env.INFERNET_TRUSTED_CLIENT_KEYS) {
    const map = new Map();
    for (const entry of String(raw ?? "").split(",")) {
        const item = entry.trim();
        if (!item) continue;
        const cut = item.lastIndexOf(":");
        const name = cut > 0 ? item.slice(0, cut) : "trusted";
        const hash = (cut > 0 ? item.slice(cut + 1) : item).toLowerCase();
        if (/^[0-9a-f]{64}$/.test(hash)) map.set(hash, name);
    }
    return map;
}

/** The trusted client a bearer key belongs to, or null. */
export function trustedClientFor(bearer, raw) {
    if (typeof bearer !== "string" || !bearer.startsWith(TRUSTED_KEY_PREFIX)) return null;
    const hash = hashKey(bearer);
    const name = trustedKeyHashes(raw).get(hash);
    return name ? { name, hash } : null;
}

const trustedLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.INFERNET_TRUSTED_CLIENT_RPH) > 0
        ? Number(process.env.INFERNET_TRUSTED_CLIENT_RPH)
        : 2000
});

/**
 * Rate-limit a request: a trusted key against its own budget, anyone else
 * against the playground limiter by IP. Returns the limiter result plus who
 * was counted.
 */
export function checkChatLimit({ bearer, ip, publicLimit }) {
    const trusted = trustedClientFor(bearer);
    if (trusted) return { ...trustedLimit.check(`trusted:${trusted.hash}`), trusted };
    return { ...publicLimit.check(ip), trusted: null };
}

/** `p2p_only` / `p2pOnly`: never hand the job to the hosted (paid) fallback. */
export function wantsP2pOnly(body) {
    const v = body?.p2p_only ?? body?.p2pOnly ?? body?.metadata?.p2p_only;
    return v === true || v === "true";
}

/**
 * A trusted client calling on behalf of one of its own signed-in people.
 *
 * c0mpute.com signs people in with CoinPay and sends their model calls here
 * under its own `ifc_` key, so without this every c0mpute user looked like one
 * anonymous caller and nobody's balance could be charged. The client names the
 * person with their CoinPay subject; Infernet maps it to an account through
 * coinpay_identities (the same binding "Sign in with CoinPay" uses) and bills
 * that account.
 *
 * Only a trusted key may do this. Otherwise any caller could name a stranger
 * and spend their balance.
 *
 * And the subject must be signed by that client (lib/billing/signed-subject.js):
 * subject|ts|request id, five-minute window, each request id once. A subject
 * the client minted itself (`c0mpute:<id>`) is never taken unsigned. Any other
 * unsigned or invalid subject is, for now, still taken and logged
 * (INFERNET_REQUIRE_SIGNED_SUBJECTS off: the soak); with the flag on it is
 * ignored and the request metered by address. Never a hard failure.
 *
 * Async (the replay check may ask the database). Memoised per request, so a
 * route that resolves the subject twice does not see its own id as a replay.
 *
 * @returns {Promise<string|null>}
 */
const decided = new WeakMap();

export function billedSubjectFrom(request, trusted, { env = process.env, claim } = {}) {
    if (!trusted) return Promise.resolve(null);
    const memoable = request && typeof request === "object";
    if (memoable && decided.has(request)) return decided.get(request);
    const p = decideSubject(request, trusted, env, claim).catch((err) => {
        console.warn(`[billed-subject] check failed, metering by address: ${err?.message ?? err}`);
        return null;
    });
    if (memoable) decided.set(request, p);
    return p;
}

async function decideSubject(request, trusted, env, claim) {
    const raw = request?.headers?.get?.("x-infernet-billed-subject") ?? null;
    if (typeof raw !== "string") return null;
    const sub = raw.trim();
    // CoinPay subjects are opaque ids; bound so a header cannot carry a payload.
    if (!(sub.length > 0 && sub.length <= 200)) return null;
    const requestId = request.headers.get("x-infernet-request-id");
    const v = verifySubjectSignature({
        subject: sub,
        ts: request.headers.get("x-infernet-subject-ts"),
        requestId,
        sig: request.headers.get("x-infernet-subject-sig"),
        trustedName: trusted.name,
        env
    });
    if (v.ok) {
        const claimFn = claim ?? (await import("@/lib/data/subject-replay")).claimRequestId;
        if (!(await claimFn(`${trusted.name}:${requestId.trim()}`))) {
            noteSubject(trusted.name, "replayed", sub, "ignored");
            return null;
        }
        return sub;
    }
    if (claimsSignedOrigin(sub) || requireSignedSubjects(env)) {
        noteSubject(trusted.name, v.reason, sub, "ignored; metering by address");
        return null;
    }
    noteSubject(trusted.name, v.reason, sub, "accepted (log-only: INFERNET_REQUIRE_SIGNED_SUBJECTS off)");
    return sub;
}

// One log line per client+reason+outcome a minute, with how many it covers:
// the soak reads these to see that no trusted key still sends unsigned
// subjects, without a line per chat message.
const NOTE_EVERY_MS = 60_000;
const notes = new Map();
function noteSubject(client, reason, sub, outcome) {
    const key = `${client}|${reason}|${outcome}`;
    const t = Date.now();
    const n = notes.get(key) ?? { at: 0, count: 0 };
    n.count += 1;
    if (t - n.at >= NOTE_EVERY_MS) {
        console.warn(`[billed-subject] ${reason === "unsigned" ? "unsigned" : "invalid"} subject from ${client}: ${reason}, ${outcome} `
            + `(${n.count} in the last minute; e.g. ${logSubject(sub)})`);
        n.at = t;
        n.count = 0;
    }
    notes.set(key, n);
}

/** Hourly budget for a caller paying from a balance: not the stranger limit. */
export const paidLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.INFERNET_PAID_RPH) > 0 ? Number(process.env.INFERNET_PAID_RPH) : 2000
});
