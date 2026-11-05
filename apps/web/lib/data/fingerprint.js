import "server-only";
import { createFingerprintGuard } from "@profullstack/browser-fingerprint";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The house fingerprint guard (@profullstack/browser-fingerprint), wired to a
 * Postgres store.
 *
 * Why it is here: the free allowance used to be keyed on a hash of the
 * caller's address, which anyone can refresh by changing address. This package
 * exists for exactly that ("one vote per browser, not per IP"), and it already
 * does the parts worth not hand-writing: a server-signed challenge so a
 * payload cannot be replayed, one-visitor-per-token so a single challenge
 * cannot mint many identities, a bot score, and a keyed hash so the
 * fingerprint itself is never stored.
 *
 * The store is Postgres rather than the package's memory store for the same
 * reason the free counter is not in memory: memory resets on every deploy, and
 * a replayed challenge token would become usable again after each one.
 */

function db() {
    return getSupabaseServerClient();
}

/** The package's Store interface over Postgres. */
function postgresStore() {
    return {
        async incr(key, ttlMs) {
            const { data, error } = await db().rpc("fingerprint_incr", {
                p_key: String(key),
                p_ttl_ms: Math.max(1, Math.floor(Number(ttlMs) || 0))
            });
            if (error) throw new Error(error.message);
            return Number(data) || 0;
        },
        async claim(key, value, ttlMs) {
            const { data, error } = await db().rpc("fingerprint_claim", {
                p_key: String(key),
                p_value: String(value),
                p_ttl_ms: Math.max(1, Math.floor(Number(ttlMs) || 0))
            });
            if (error) throw new Error(error.message);
            // null = we are the first holder, which is what the guard reads as
            // "this token has not been used before".
            return data ?? null;
        }
    };
}

/**
 * The signing secret. A dedicated one if set, else the key the app already
 * has, so there is no new secret to provision for this to work.
 */
function secret() {
    const s = process.env.INFERNET_FINGERPRINT_SECRET || process.env.INFERNET_DB_ENCRYPTION_KEY || "";
    return s.length >= 32 ? s : "";
}

let cached;

/** The guard, or null when there is no usable secret (then the caller falls back). */
export function fingerprintGuard() {
    if (cached !== undefined) return cached;
    const s = secret();
    if (!s) {
        console.warn("[fingerprint] no INFERNET_FINGERPRINT_SECRET or INFERNET_DB_ENCRYPTION_KEY: falling back to address keys");
        cached = null;
        return cached;
    }
    cached = createFingerprintGuard({
        secret: s,
        store: postgresStore(),
        // A challenge is for one submission, so one token cannot mint many
        // visitor identities.
        oneVisitorPerToken: true,
        bindIp: true
    });
    return cached;
}

/** Test hook. */
export function setFingerprintGuardForTest(g) {
    cached = g;
}

/**
 * Identify the caller for the free tier.
 *
 * Returns { visitorKey, ipKey, bot, confidence, ok, reason } with keyed hashes
 * only, never the fingerprint. Never throws: an unusable or missing payload
 * just means no visitorKey, and the caller falls back to the address key.
 */
export async function identifyVisitor({ payload, ip, userAgent } = {}) {
    const guard = fingerprintGuard();
    if (!guard) return { ok: false, reason: "unconfigured", visitorKey: null, ipKey: null, bot: null };
    try {
        const v = await guard.verify({ payload, ip, userAgent });
        return v;
    } catch (err) {
        console.warn(`[fingerprint] verify failed: ${err?.message ?? err}`);
        return { ok: false, reason: "error", visitorKey: null, ipKey: null, bot: null };
    }
}

/** A short-lived challenge token for the page to collect against. */
export async function issueFingerprintChallenge({ ip } = {}) {
    const guard = fingerprintGuard();
    if (!guard) return null;
    try {
        return await guard.issueChallenge({ ip });
    } catch (err) {
        console.warn(`[fingerprint] challenge failed: ${err?.message ?? err}`);
        return null;
    }
}
