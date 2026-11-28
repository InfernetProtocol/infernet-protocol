import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { runGatewayJob, gatewayError, readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";
import { resolveBillingCaller, authorizeInteractive, chargeImageJob } from "@/lib/data/interactive-billing";
import { consumeFreeQuery } from "@/lib/data/free-tier";
import { freeLimitMessage } from "@/lib/billing/free-tier";
import { adultRefusal, passthroughStatus, validateVideoRequest } from "@/lib/billing/video";
import { startImageJob } from "@/lib/chat/image-jobs";
import { busyMeter, computePriceMicro, estimatePriceMicro } from "@/lib/billing/compute-price";
import { clipJobs, clipMaxRunning, startClip } from "@/lib/video/clip-run";
import { hasFfmpeg } from "@/lib/promo/assemble";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A clip holds a GPU worker for half an hour: strangers get two an hour.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 2 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/chat/video  { prompt, model?, seconds?, vertical?, negative_prompt?, seed?, adult? }
 * The default is a 30 s clip on Wan 2.2 5B: a chat model plans 5 s shots of
 * the same subjects, each renders on a c0mpute GPU worker, and this server
 * cuts them together (lib/video/clip-run.js; durable across deploys).
 * `seconds` (5-60) or a length in the prompt ("a 15 second video") sets it;
 * `vertical: true` renders 9:16. Billed one clip price per shot rendered.
 * `model: "wan2.1-t2v-1.3b"` is a ~2 s CPU draft.
 * `model: "chatrxl-uncensored"` (SFW only) first draws the opening frame with
 * ChatrXL on a CPU worker, then animates it with Wan 2.2 5B image-to-video;
 * it bills one image plus one clip.
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
  const long = parsed.long ?? null;
  if (long) {
    if (!hasFfmpeg()) return errorJson("Long clips are not available on this server (no ffmpeg)", 503);
    if (clipJobs.running() >= clipMaxRunning()) return errorJson("Every video slot is busy; try again in a few minutes", 503);
  }

  const ip = getClientIp(request);
  const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
  const payer = await resolveBillingCaller(request, { trusted });
  const billing = await authorizeInteractive({ userId: payer.userId, model: parsed.spec.model });
  if (billing.mode === "insufficient") {
    return errorJson("Out of compute balance", 402, `spendable ${billing.spendable_usd} USD`);
  }
  // Up-front check at a typical ~11 min of GPU per Wan 2.2 5B shot (the bill is the measured time).
  const estimate = long ? long.shots * estimatePriceMicro("video", 660) : 0;
  if (long && billing.mode === "balance" && billing.spendable_micro < estimate) {
    return errorJson(
      "Out of compute balance",
      402,
      `a ${long.seconds} s clip is ${long.shots} shots, about ${(estimate / 1e6).toFixed(2)} USD of GPU time; spendable ${billing.spendable_usd} USD`
    );
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

  if (long) {
    if (body?.adult === true) long.adult = true;
    const billingRecord = { mode: billing.mode, userId: payer.userId ?? null };
    const id = startClip(long, billingRecord);
    return Response.json(
      { id, status: "pending", model: long.model, seconds: long.seconds, shots: long.shots, poll: `/api/chat/video/${id}`, video: `/api/chat/video/${id}/video` },
      { status: 202, headers: { "cache-control": "no-store" } }
    );
  }

  const userId = payer.userId;
  const chargeMode = billing.mode;
  const keyframe = parsed.keyframe ?? null;
  const id = startImageJob(async (job) => {
    const progress = (prefix) => (p) => {
      job.meta = {
        stage: prefix ? `${prefix}: ${p.stage}` : p.stage,
        detail: typeof p.detail === "string" ? p.detail.slice(0, 200) : undefined,
        queue_position: Number.isFinite(p.queue_position) ? p.queue_position : undefined,
        elapsed_s: Number.isFinite(p.elapsed_s) ? p.elapsed_s : undefined,
        eta_s: Number.isFinite(p.eta_s) ? p.eta_s : undefined
      };
    };
    const header = (res, name) => {
      const v = res.headers[name];
      return Array.isArray(v) ? v[0] ?? "" : v ?? "";
    };
    const spec = { ...parsed.spec };
    let keyframeCharge = null;
    let keyframeSeconds = 0;
    const clipMeter = busyMeter();
    if (keyframe) {
      // Step 1: the first frame, on a CPU worker that has the model.
      let still;
      const kfMeter = busyMeter();
      try {
        still = await runGatewayJob("/v1/images", keyframe, { requestId: `${job.id}-keyframe`, onProgress: kfMeter.wrap(progress(`first frame (${keyframe.model})`)) });
      } catch (error) {
        throw Object.assign(new Error(`First frame failed: ${error?.message ?? error}`), { status: Number(error?.status) || 502 });
      }
      if (still.status !== 200) {
        throw Object.assign(new Error(gatewayError(still) || "First frame failed"), { status: passthroughStatus(still.status) });
      }
      keyframeSeconds = kfMeter.seconds();
      spec.image_base64 = Buffer.from(still.body).toString("base64");
      const stillJob = header(still, "x-c0mpute-job-id");
      if (chargeMode === "balance" && UUID.test(stillJob)) {
        keyframeCharge = await chargeImageJob({ userId, jobId: stillJob, costMicro: computePriceMicro("image", keyframeSeconds) });
      }
    }
    let response;
    try {
      // Step 2 (or the only step): the clip.
      response = await runGatewayJob("/v1/videos", spec, {
        requestId: job.id,
        onProgress: clipMeter.wrap(progress(keyframe ? "animating" : ""))
      });
    } catch (error) {
      throw Object.assign(new Error(`Video generation failed: ${error?.message ?? error}`), { status: Number(error?.status) || 502 });
    }
    if (response.status !== 200) {
      const why = gatewayError(response);
      throw Object.assign(new Error(why || "Video generation failed"), { status: passthroughStatus(response.status) });
    }
    const mp4 = new Uint8Array(response.body);
    const jobId = header(response, "x-c0mpute-job-id");
    const worker = header(response, "x-c0mpute-worker-peer-id");
    let charge = null;
    if (chargeMode === "balance" && UUID.test(jobId)) {
      charge = await chargeImageJob({ userId, jobId, costMicro: computePriceMicro("video", clipMeter.seconds()) });
    }
    return {
      png: mp4,
      headers: {
        "x-video-model": parsed.spec.model,
        ...(keyframe ? { "x-keyframe-model": keyframe.model } : {}),
        ...(keyframeCharge?.charged ? { "x-keyframe-charged-usd": keyframeCharge.charged_usd } : {}),
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
