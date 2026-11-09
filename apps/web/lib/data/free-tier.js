import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import {
    resolveFreeAllowance,
    resolveOperatorAllowance,
    pickFreeLimit,
    createOperatorCache,
    musicSubject,
    operatorSongLimit,
    freeSubject,
    looksLikeBot,
    secondsUntilReset,
    DEFAULT_FREE_QUERIES_PER_DAY,
    DEFAULT_OPERATOR_FREE_SONGS_PER_DAY
} from "@/lib/billing/free-tier";
import { identifyVisitor } from "@/lib/data/fingerprint";

/**
 * Spend one free query, or refuse.
 *
 * The count is in the database so it survives a deploy and is shared across
 * processes. If the database cannot be reached the request still gets limited,
 * just not durably: it falls back to an in-process hourly bucket sized to the
 * same daily number. Failing open would hand out unlimited free inference at
 * exactly the moment we cannot see what is happening.
 */

function db(supabase) {
    return supabase ?? getSupabaseServerClient();
}

async function readSettings(supabase) {
    try {
        const { data } = await db(supabase)
            .from("settings")
            .select("value")
            .eq("key", "interactive_billing")
            .maybeSingle();
        return data?.value ?? null;
    } catch {
        return null; /* defaults + env */
    }
}

export async function getFreeAllowance(supabase) {
    return resolveFreeAllowance({ env: process.env, settings: await readSettings(supabase) });
}

// operator_qualifies() aggregates a day of probes, so it is asked at most once
// per user per five minutes. A slow database must not hold the request: after
// two seconds the answer is "not an operator", and the normal limit applies.
const OPERATOR_CHECK_TIMEOUT_MS = 2000;
const isQualifyingOperator = createOperatorCache({
    check: async (userId) => {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("operator_qualifies timed out")), OPERATOR_CHECK_TIMEOUT_MS);
        });
        try {
            const { data, error } = await Promise.race([
                getSupabaseServerClient().rpc("operator_qualifies", { p_user_id: userId }),
                timeout
            ]);
            if (error) throw error;
            return data;
        } catch (err) {
            console.warn(`[free-tier] operator check failed, using the normal limit: ${err?.message ?? err}`);
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }
});

export { isQualifyingOperator };

// The fallback when the ledger is unreachable. Hourly rather than daily
// because an in-memory daily window is the thing this whole table exists to
// avoid; an hour of the same budget is a reasonable stand-in.
const fallback = rateLimit({ windowMs: 60 * 60 * 1000, max: DEFAULT_FREE_QUERIES_PER_DAY });
const songFallback = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: DEFAULT_OPERATOR_FREE_SONGS_PER_DAY });

/**
 * @returns {Promise<{ok: boolean, used?: number, remaining?: number, limit: number,
 *                     retryAfter: number, subject: string|null, degraded?: boolean}>}
 */
export async function consumeFreeQuery({
    userId = null,
    clientSubject = null,
    ip = null,
    fingerprint = null,
    userAgent = null,
    supabase,
    operatorCheck = isQualifyingOperator
} = {}) {
    const settings = await readSettings(supabase);
    const base = resolveFreeAllowance({ env: process.env, settings });
    const operatorLimit = resolveOperatorAllowance({ settings }).queries;
    // Only an account can be an operator (pubkey_links hangs off auth.users).
    // The check never throws: a failure is "not an operator", the normal limit.
    const operator = userId ? await operatorCheck(userId).catch(() => false) : false;
    // Same counter key either way (user:<id>): only the ceiling moves.
    const limit = pickFreeLimit({ base, operatorLimit, qualifies: operator });
    const retryAfter = secondsUntilReset();
    const info = { operator, operatorLimit };

    // Identify the device, not the address (@profullstack/browser-fingerprint).
    // Only needed for an anonymous caller: a signed-in account is already a
    // better key than any fingerprint.
    let visitorKey = null;
    let ipKey = null;
    let bot = null;
    if (!userId && !clientSubject) {
        const v = await identifyVisitor({ payload: fingerprint, ip, userAgent });
        // visitorKey is set for any well-formed payload, but only a payload
        // that actually verified may spend an allowance: otherwise a replayed
        // or made-up one would mint identities at will.
        visitorKey = v.ok ? v.visitorKey : null;
        ipKey = v.ipKey ?? null;
        bot = v.bot ?? null;
    }

    const subject = freeSubject({ userId, clientSubject, visitorKey, ipKey });

    // Nothing to key on (no account, no address, nothing collected). Refuse
    // rather than serve an uncountable free request.
    if (!subject) return { ok: false, limit, retryAfter, subject: null, reason: "no_subject", ...info };

    // A confident bot signal costs the free tier, not the paid one: anything
    // automated is welcome to top up and keep going.
    if (looksLikeBot(bot)) {
        return { ok: false, limit, retryAfter, subject, reason: "bot", bot, ...info };
    }

    try {
        const { data, error } = await db(supabase).rpc("free_query_consume", {
            p_subject: subject,
            p_max: limit
        });
        if (error) throw error;
        const out = data ?? {};
        return {
            ok: Boolean(out.allowed),
            used: Number(out.used ?? 0),
            remaining: Number(out.remaining ?? 0),
            limit,
            retryAfter,
            subject,
            ...info
        };
    } catch (err) {
        console.warn(`[free-tier] ledger unavailable, falling back in memory: ${err?.message ?? err}`);
        const r = fallback.check(subject);
        return {
            ok: r.ok,
            remaining: r.remaining,
            limit,
            retryAfter: Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000)),
            subject,
            degraded: true,
            ...info
        };
    }
}

/**
 * Spend one of a qualifying operator's free songs for today, or refuse.
 *
 * A song holds a music worker for minutes, so the operator's 100 free queries
 * do not become 100 free songs: an operator's free song also spends one from
 * this separate counter (music:user:<id>, the same free_query_consume
 * mechanism), capped at operator_free_songs_per_day. Callers who are not
 * qualifying operators are not affected; this returns { applies: false }.
 *
 * @returns {Promise<{applies: boolean, ok: boolean, limit?: number, used?: number,
 *                     remaining?: number, retryAfter?: number, degraded?: boolean}>}
 */
export async function consumeOperatorSong({ userId = null, supabase, operatorCheck = isQualifyingOperator } = {}) {
    const subject = musicSubject(userId);
    if (!subject) return { applies: false, ok: true };
    const operator = await operatorCheck(userId).catch(() => false);
    if (!operator) return { applies: false, ok: true };
    const settings = await readSettings(supabase);
    const limit = operatorSongLimit({
        songs: resolveOperatorAllowance({ settings }).songs,
        base: resolveFreeAllowance({ env: process.env, settings })
    });
    const retryAfter = secondsUntilReset();
    try {
        const { data, error } = await db(supabase).rpc("free_query_consume", { p_subject: subject, p_max: limit });
        if (error) throw error;
        const out = data ?? {};
        return {
            applies: true,
            ok: Boolean(out.allowed),
            used: Number(out.used ?? 0),
            remaining: Number(out.remaining ?? 0),
            limit,
            retryAfter
        };
    } catch (err) {
        console.warn(`[free-tier] song ledger unavailable, falling back in memory: ${err?.message ?? err}`);
        const r = songFallback.check(subject);
        return { applies: true, ok: r.ok, remaining: r.remaining, limit, retryAfter, degraded: true };
    }
}

/** How much of today's allowance is left, without spending any of it. */
export async function peekFreeQuery({ userId = null, clientSubject = null, visitorKey = null, ipKey = null, supabase, operatorCheck = isQualifyingOperator } = {}) {
    const settings = await readSettings(supabase);
    const operator = userId ? await operatorCheck(userId).catch(() => false) : false;
    const limit = pickFreeLimit({
        base: resolveFreeAllowance({ env: process.env, settings }),
        operatorLimit: resolveOperatorAllowance({ settings }).queries,
        qualifies: operator
    });
    const subject = freeSubject({ userId, clientSubject, visitorKey, ipKey });
    if (!subject) return { limit, used: 0, remaining: 0, subject: null };
    try {
        const { data } = await db(supabase)
            .from("free_queries")
            .select("used")
            .eq("subject", subject)
            .eq("day", new Date().toISOString().slice(0, 10))
            .maybeSingle();
        const used = Number(data?.used ?? 0);
        return { limit, used, remaining: Math.max(0, limit - used), subject };
    } catch {
        return { limit, used: 0, remaining: limit, subject };
    }
}
