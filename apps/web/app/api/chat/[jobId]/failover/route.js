import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getClientIp, rateLimit } from "@/lib/rate-limit";
import { issueChatRetryToken } from "@/lib/chat/retry-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 12 });

/**
 * POST /api/chat/<jobId>/failover
 * Mark a no-token chat attempt failed and issue a one-use retry grant.
 * The grant is bound to this client address and browser fingerprint.
 */
export async function POST(request, { params }) {
    const ip = getClientIp(request);
    if (!limit.check(ip).ok) {
        return NextResponse.json({ error: "Too many chat failover attempts" }, { status: 429 });
    }

    const { jobId } = await params;
    if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId)) {
        return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return NextResponse.json({ error: "Chat failover is unavailable" }, { status: 503 });
    }

    const db = getSupabaseServerClient();
    const { data: job, error: jobError } = await db.from("jobs")
        .select("id,status,provider_id,created_at")
        .eq("id", jobId)
        .maybeSingle();
    if (jobError) return NextResponse.json({ error: "Could not check the chat job" }, { status: 500 });
    if (!job) return NextResponse.json({ error: "Chat job not found" }, { status: 404 });
    if (!job.provider_id || !["assigned", "running"].includes(job.status)) {
        return NextResponse.json({ error: "Chat job is no longer eligible for failover" }, { status: 409 });
    }
    const ageMs = Date.now() - new Date(job.created_at).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 14_000 || ageMs > 5 * 60_000) {
        return NextResponse.json({ error: "Chat job is outside the failover window" }, { status: 409 });
    }

    const { count, error: eventError } = await db.from("job_events")
        .select("id", { count: "exact", head: true })
        .eq("job_id", jobId)
        .eq("event_type", "token");
    if (eventError) return NextResponse.json({ error: "Could not check chat progress" }, { status: 500 });
    if ((count ?? 0) > 0) {
        return NextResponse.json({ error: "The provider already started responding" }, { status: 409 });
    }

    const nonce = randomBytes(18).toString("base64url");
    const marker = `first_token_timeout:${nonce}`;
    const expiresAt = Date.now() + 120_000;
    const fingerprint = request.headers.get("x-fingerprint") ?? "";
    const retryToken = issueChatRetryToken({ jobId, nonce, expiresAt, ip, fingerprint });
    if (!retryToken) return NextResponse.json({ error: "Chat failover is unavailable" }, { status: 503 });

    const { data: failed, error: updateError } = await db.from("jobs")
        .update({ status: "failed", error: marker, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .in("status", ["assigned", "running"])
        .select("id")
        .maybeSingle();
    if (updateError) return NextResponse.json({ error: "Could not fail over this chat job" }, { status: 500 });
    if (!failed) return NextResponse.json({ error: "The chat job changed while failover was starting" }, { status: 409 });

    return NextResponse.json({ retryToken, expiresAt }, { headers: { "cache-control": "no-store" } });
}
