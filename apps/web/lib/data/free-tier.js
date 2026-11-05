import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import {
    resolveFreeAllowance,
    freeSubject,
    secondsUntilReset,
    DEFAULT_FREE_QUERIES_PER_DAY
} from "@/lib/billing/free-tier";

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
export async function consumeFreeQuery({ userId = null, clientSubject = null, ip = null, supabase } = {}) {
    const limit = await getFreeAllowance(supabase);
    const salt = process.env.INFERNET_FREE_TIER_SALT || process.env.INFERNET_DB_ENCRYPTION_KEY || "";
    const subject = freeSubject({ userId, clientSubject, ip, salt });
    const retryAfter = secondsUntilReset();

    // Nothing to key on (no account, no address). Refuse rather than serve an
    // uncountable free request.
    if (!subject) return { ok: false, limit, retryAfter, subject: null, reason: "no_subject" };

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
export async function peekFreeQuery({ userId = null, ip = null, supabase } = {}) {
    const limit = await getFreeAllowance(supabase);
    const salt = process.env.INFERNET_FREE_TIER_SALT || process.env.INFERNET_DB_ENCRYPTION_KEY || "";
    const subject = freeSubject({ userId, ip, salt });
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
