import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { decryptJSON } from "@/lib/encrypt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/chat/<jobId>/status
 *
 * Reads the persisted job state. The playground / OpenAI shim hits
 * this when the SSE connection drops mid-stream — the browser's
 * native EventSource error has no `.data`, so we have nowhere to
 * surface the real failure reason from the stream itself. This
 * endpoint pulls it from job rows + the most recent error-shaped
 * job_event so the UI can show "Provider OOM'd loading qwen3.5:9b"
 * instead of a generic "Stream error".
 *
 * Public read — no auth, but rate-limited at the Fastly edge layer
 * (and the response body is bounded). The job_events scan caps at
 * 5 most-recent events to keep the row scan tight.
 */
export async function GET(_request, { params }) {
    const { jobId } = await params;
    if (!jobId || typeof jobId !== "string") {
        return NextResponse.json({ error: "jobId required" }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    const [{ data: job, error: jobErr }, { data: events }, { count: tokenCount }] = await Promise.all([
        supabase
            .from("jobs")
            .select("id, status, error, model_name, provider_id, created_at, completed_at, updated_at")
            .eq("id", jobId)
            .maybeSingle(),
        supabase
            .from("job_events")
            .select("event_type, data, created_at")
            .eq("job_id", jobId)
            .order("id", { ascending: false })
            .limit(20),
        supabase
            .from("job_events")
            .select("id", { count: "exact", head: true })
            .eq("job_id", jobId)
            .eq("event_type", "token")
    ]);

    if (jobErr) {
        return NextResponse.json({ error: jobErr.message }, { status: 500 });
    }
    if (!job) {
        return NextResponse.json({ error: "job not found" }, { status: 404 });
    }

    const eventsList = events ?? [];
    const errEvent = eventsList.find((e) => e.event_type === "error");
    const doneEvent = eventsList.find((e) => e.event_type === "done");
    let latestDoneEncryptedText = null;
    let latestDoneReason = null;
    if (doneEvent?.data) {
        try {
            const doneData = decryptJSON(doneEvent.data);
            if (typeof doneData?.encrypted_text === "string") {
                latestDoneEncryptedText = doneData.encrypted_text;
            }
            if (typeof doneData?.reason === "string") latestDoneReason = doneData.reason;
        } catch { /* don't turn a diagnostic endpoint into a job failure */ }
    }
    const lastEvent = eventsList[0] ?? null;
    const lastEventAgeMs = lastEvent?.created_at
        ? Date.now() - new Date(lastEvent.created_at).getTime()
        : null;

    // Synthesize a useful error string when no explicit error event exists.
    // The frontend's "Stream error" fallback hits when the daemon crashed
    // mid-stream without writing { event_type:"error" }; this gives the
    // user something actionable instead of nothing.
    const explicit = errEvent?.data?.message ?? job.error ?? null;
    const synthesized = (() => {
        if (explicit) return explicit;
        if (job.status !== "failed" && job.status !== "running") return null;

        const nodePart = job.provider_id ? `node ${String(job.provider_id).slice(0, 8)}` : "the provider";
        const modelPart = job.model_name ? ` (${job.model_name})` : "";
        const tokensPart = tokenCount ? ` after ${tokenCount} token${tokenCount === 1 ? "" : "s"}` : "";

        if (eventsList.length === 0) {
            return `Job dispatched but ${nodePart}${modelPart} never reported back. ` +
                   `The daemon may be offline or the model isn't pulled.`;
        }
        if (lastEventAgeMs != null && lastEventAgeMs > 60_000) {
            const secs = Math.round(lastEventAgeMs / 1000);
            return `Stream stalled${tokensPart} — ${nodePart}${modelPart} hasn't sent anything for ${secs}s.`;
        }
        if (job.status === "failed") {
            return `Job marked failed${tokensPart} but ${nodePart}${modelPart} didn't write an error message. ` +
                   `Likely an unhandled crash on the daemon side.`;
        }
        return null;
    })();

    return NextResponse.json({
        id: job.id,
        status: job.status,
        model_name: job.model_name,
        provider_id: job.provider_id,
        error: job.error ?? null,
        latest_error_message: explicit ?? synthesized,
        token_count: tokenCount ?? 0,
        last_event_type: lastEvent?.event_type ?? null,
        latest_done_encrypted_text: latestDoneEncryptedText,
        latest_done_reason: latestDoneReason,
        last_event_age_ms: lastEventAgeMs,
        completed_at: job.completed_at ?? null,
        updated_at: job.updated_at ?? null
    }, {
        headers: { "cache-control": "no-store" }
    });
}
