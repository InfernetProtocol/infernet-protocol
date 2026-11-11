import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { runGatewayJob, gatewayError, readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";
import { resolveBillingCaller, authorizeInteractive, chargeImageJob } from "@/lib/data/interactive-billing";
import { consumeFreeQuery } from "@/lib/data/free-tier";
import { freeLimitMessage } from "@/lib/billing/free-tier";
import { adultRefusal, passthroughStatus, validateVideoRequest, videoPriceMicro } from "@/lib/billing/video";
import { startImageJob } from "@/lib/chat/image-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A clip holds a whole CPU worker for 20-30 minutes: strangers get two an hour.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 2 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/chat/video  { prompt, model?, negative_prompt?, seed?, adult? }
 * → 202 { id, poll }. Poll GET /api/chat/video/<id> (JSON status); when done,
 * GET /api/chat/video/<id>/video serves the MP4 (Range supported). The clip
 * waits in the c0mpute gateway's queue for a worker up to 2 h, then renders.
 * Billed a flat price per clip on a balance, or one free daily query.
 */
export async function POST(request) {
  if (!speechGateway()) return errorJson("Video generation is not configured", 503);
  let body;
  try {
    const bytes = await readLimitedBody(request, 16 * 1024);
    if (!bytes) return errorJson("Video request is too large", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorJson("Invalid JSON body", 400);
  }
  const parsed = validateVideoRequest(body);
  if (!parsed.ok) return errorJson(parsed.error, 400);

  const ip = getClientIp(request);
  const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
  const payer = await resolveBillingCaller(request, { trusted });
  const billing = await authorizeInteractive({ userId: payer.userId, model: parsed.spec.model });
  if (billing.mode === "insufficient") {
    return errorJson("Out of compute balance", 402, `spendable ${billing.spendable_usd} USD`);
  }
  const adult = adultRefusal({ adult: body?.adult, trusted, billingMode: billing.mode });
  if (adult) return errorJson(adult.error, adult.status);
  if (body?.adult === true) parsed.spec.adult = true;
  if (billing.mode === "balance" || billing.mode === "admin") {
    const pr = paidLimit.check(`paid:${payer.userId}`);
    if (!pr.ok) return errorJson("Rate limit exceeded — try again later", 429);
  } else {
    const burst = limit.check(ip);
    if (!burst.ok) return errorJson("Video rate limit exceeded — try again later", 429);
    const free = await consumeFreeQuery({
      userId: payer.userId ?? null,
      clientSubject: payer.subject ?? null,
      ip,
      fingerprint: request.headers.get("x-fingerprint"),
      userAgent: request.headers.get("user-agent")
    });
    if (!free.ok) return errorJson(freeLimitMessage(free.limit, free), 429);
  }

  const userId = payer.userId;
  const chargeMode = billing.mode;
  const id = startImageJob(async (job) => {
    let response;
    try {
      response = await runGatewayJob("/v1/videos", parsed.spec, {
        requestId: job.id,
        onProgress: (p) => {
          job.meta = {
            stage: p.stage,
            detail: typeof p.detail === "string" ? p.detail.slice(0, 200) : undefined,
            queue_position: Number.isFinite(p.queue_position) ? p.queue_position : undefined,
            elapsed_s: Number.isFinite(p.elapsed_s) ? p.elapsed_s : undefined,
            eta_s: Number.isFinite(p.eta_s) ? p.eta_s : undefined
          };
        }
      });
    } catch (error) {
      throw Object.assign(new Error(`Video generation failed: ${error?.message ?? error}`), { status: Number(error?.status) || 502 });
    }
    if (response.status !== 200) {
      const why = gatewayError(response);
      throw Object.assign(new Error(why || "Video generation failed"), { status: passthroughStatus(response.status) });
    }
    const mp4 = new Uint8Array(response.body);
    const header = (name) => {
      const v = response.headers[name];
      return Array.isArray(v) ? v[0] ?? "" : v ?? "";
    };
    const jobId = header("x-c0mpute-job-id");
    const worker = header("x-c0mpute-worker-peer-id");
    let charge = null;
    if (chargeMode === "balance" && UUID.test(jobId)) {
      charge = await chargeImageJob({ userId, jobId, costMicro: videoPriceMicro() });
    }
    return {
      png: mp4,
      headers: {
        "x-video-model": parsed.spec.model,
        ...(parsed.spec.adult ? { "x-adult": "1" } : {}),
        ...(jobId ? { "x-c0mpute-job-id": jobId } : {}),
        ...(worker ? { "x-c0mpute-worker-peer-id": worker } : {}),
        ...(charge?.charged ? { "x-charged-usd": charge.charged_usd } : {})
      }
    };
  });
  return Response.json(
    { id, status: "pending", poll: `/api/chat/video/${id}`, video: `/api/chat/video/${id}/video` },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
}
