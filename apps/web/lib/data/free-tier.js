import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import {
    resolveFreeAllowance,
    freeSubject,
    looksLikeBot,
    secondsUntilReset,
    DEFAULT_FREE_QUERIES_PER_DAY
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

export async function getFreeAllowance(supabase) {
    let settings = null;
    try {
        const { data } = await db(supabase)
            .from("settings")
            .select("value")
            .eq("key", "interactive_billing")
            .maybeSingle();
        settings = data?.value ?? null;
    } catch {
        /* defaults + env */
    }
    return resolveFreeAllowance({ env: process.env, settings });
}

// The fallback when the ledger is unreachable. Hourly rather than daily
// because an in-memory daily window is the thing this whole table exists to
// avoid; an hour of the same budget is a reasonable stand-in.
const fallback = rateLimit({ windowMs: 60 * 60 * 1000, max: DEFAULT_FREE_QUERIES_PER_DAY });

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
    supabase
} = {}) {
    const limit = await getFreeAllowance(supabase);
    const retryAfter = secondsUntilReset();

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
    if (!subject) return { ok: false, limit, retryAfter, subject: null, reason: "no_subject" };

    // A confident bot signal costs the free tier, not the paid one: anything
    // automated is welcome to top up and keep going.
    if (looksLikeBot(bot)) {
        return { ok: false, limit, retryAfter, subject, reason: "bot", bot };
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
            subject
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
            degraded: true
        };
    }
}

/** How much of today's allowance is left, without spending any of it. */
export async function peekFreeQuery({ userId = null, clientSubject = null, visitorKey = null, ipKey = null, supabase } = {}) {
    const limit = await getFreeAllowance(supabase);
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
