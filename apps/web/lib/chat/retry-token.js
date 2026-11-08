import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function secret() {
    return process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function signature(encoded, ip, fingerprint, key = secret()) {
    if (!key) return null;
    return createHmac("sha256", key)
        .update(`${encoded}\n${String(ip ?? "")}\n${String(fingerprint ?? "")}`)
        .digest("base64url");
}

/** A one-use, short-lived grant to retry a chat job after a no-token timeout. */
export function issueChatRetryToken({ jobId, nonce, expiresAt, ip, fingerprint }) {
    const payload = Buffer.from(JSON.stringify({ v: 1, jobId, nonce, expiresAt })).toString("base64url");
    const sig = signature(payload, ip, fingerprint);
    return sig ? `${payload}.${sig}` : null;
}

export function verifyChatRetryToken(token, { ip, fingerprint, now = Date.now() } = {}) {
    if (typeof token !== "string" || token.length > 2048) return null;
    const [encoded, provided, extra] = token.split(".");
    if (!encoded || !provided || extra !== undefined) return null;
    const expected = signature(encoded, ip, fingerprint);
    if (!expected) return null;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (
            payload?.v !== 1
            || typeof payload.jobId !== "string"
            || typeof payload.nonce !== "string"
            || !/^[A-Za-z0-9_-]{20,64}$/.test(payload.nonce)
            || !Number.isFinite(payload.expiresAt)
            || payload.expiresAt < now
        ) return null;
        return payload;
    } catch {
        return null;
    }
}

/** Consume the token by changing its source job's error marker exactly once. */
export async function consumeChatRetryToken({ token, ip, fingerprint, supabase } = {}) {
    const payload = verifyChatRetryToken(token, { ip, fingerprint });
    if (!payload) return { ok: false, status: 403, error: "Invalid or expired chat retry token" };

    const db = supabase ?? getSupabaseServerClient();
    const marker = `first_token_timeout:${payload.nonce}`;
    const { data: job, error: jobError } = await db.from("jobs")
        .select("id,status,error")
        .eq("id", payload.jobId)
        .maybeSingle();
    if (jobError) return { ok: false, status: 500, error: "Could not validate the chat retry" };
    if (!job || job.status !== "failed" || job.error !== marker) {
        return { ok: false, status: 409, error: "This chat retry was already used or is no longer available" };
    }

    const { count, error: eventError } = await db.from("job_events")
        .select("id", { count: "exact", head: true })
        .eq("job_id", payload.jobId)
        .eq("event_type", "token");
    if (eventError) return { ok: false, status: 500, error: "Could not validate the chat retry" };
    if ((count ?? 0) > 0) {
        return { ok: false, status: 409, error: "The original provider already started responding" };
    }

    const consumed = await db.from("jobs")
        .update({ error: `${marker}:consumed` })
        .eq("id", payload.jobId)
        .eq("status", "failed")
        .eq("error", marker)
        .select("id")
        .maybeSingle();
    if (consumed.error) return { ok: false, status: 500, error: "Could not claim the chat retry" };
    if (!consumed.data) return { ok: false, status: 409, error: "This chat retry was already used" };
    return { ok: true, jobId: payload.jobId };
}
