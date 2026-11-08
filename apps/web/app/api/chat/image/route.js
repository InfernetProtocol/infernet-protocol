import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { fetchSpeechGateway, readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";
import { resolveBillingCaller, authorizeInteractive, chargeImageJob } from "@/lib/data/interactive-billing";
import { consumeFreeQuery } from "@/lib/data/free-tier";
import { freeLimitMessage } from "@/lib/billing/free-tier";
import { IMAGE_MODEL, imagePriceMicro, validateImageRequest } from "@/lib/billing/image";
import { startImageJob } from "@/lib/chat/image-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One image holds a whole CPU worker for ~2 minutes, so strangers get a
// tighter burst budget than chat on top of the daily free allowance.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 6 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/chat/image  { prompt, size?: "landscape"|"square"|"portrait", seed? }
 * → 202 { id, poll }. Poll GET /api/chat/image/<id> for the image/png, which a
 * c0mpute CPU worker (Z-Image-Turbo) draws through the same gateway as voice. Free callers spend one of their daily free queries;
 * signed-in callers with a balance pay a flat per-image price.
 */
export async function POST(request) {
  if (!speechGateway()) return errorJson("Image generation is not configured", 503);
  if (Number(request.headers.get("content-length") ?? 0) > 16 * 1024) {
    return errorJson("Image request is too large", 413);
  }
  let body;
  try {
    const bytes = await readLimitedBody(request, 16 * 1024);
    if (!bytes) return errorJson("Image request is too large", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorJson("Invalid JSON body", 400);
  }
  const parsed = validateImageRequest(body);
  if (!parsed.ok) return errorJson(parsed.error, 400);

  const ip = getClientIp(request);
  const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
  const payer = await resolveBillingCaller(request, { trusted });
  const billing = await authorizeInteractive({ userId: payer.userId, model: IMAGE_MODEL });
  if (billing.mode === "insufficient") {
    return errorJson("Out of compute balance", 402, `spendable ${billing.spendable_usd} USD`);
  }
  if (billing.mode === "balance") {
    const pr = paidLimit.check(`paid:${payer.userId}`);
    if (!pr.ok) return errorJson("Rate limit exceeded — try again later", 429);
  } else {
    const burst = limit.check(ip);
    if (!burst.ok) return errorJson("Image rate limit exceeded — try again later", 429);
    const free = await consumeFreeQuery({
      userId: payer.userId ?? null,
      clientSubject: payer.subject ?? null,
      ip,
      fingerprint: request.headers.get("x-fingerprint"),
      userAgent: request.headers.get("user-agent")
    });
    if (!free.ok) return errorJson(freeLimitMessage(free.limit), 429);
  }

  const userId = payer.userId;
  const chargeMode = billing.mode;
  const id = startImageJob(async () => {
    let response;
    try {
      response = await fetchSpeechGateway("/v1/images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.spec),
        // The gateway runs the auction and retries other workers itself.
        signal: AbortSignal.timeout(14 * 60 * 1000)
      });
    } catch (error) {
      throw Object.assign(new Error(`Image generation failed: ${error?.message ?? error}`), { status: 502 });
    }
    if (!response) throw Object.assign(new Error("Image generation is not configured"), { status: 503 });
    if (!response.ok) {
      const busy = response.status === 503;
      throw Object.assign(
        new Error(busy ? "No c0mpute image worker is free right now — try again in a few minutes" : "Image generation failed"),
        { status: busy ? 503 : 502 }
      );
    }
    const png = new Uint8Array(await response.arrayBuffer());
    const jobId = response.headers.get("x-c0mpute-job-id") ?? "";
    const worker = response.headers.get("x-c0mpute-worker-peer-id") ?? "";
    let charge = null;
    if (chargeMode === "balance" && UUID.test(jobId)) {
      charge = await chargeImageJob({ userId, jobId, costMicro: imagePriceMicro() });
    }
    return {
      png,
      headers: {
        "x-image-model": IMAGE_MODEL,
        ...(jobId ? { "x-c0mpute-job-id": jobId } : {}),
        ...(worker ? { "x-c0mpute-worker-peer-id": worker } : {}),
        ...(charge?.charged ? { "x-charged-usd": charge.charged_usd } : {})
      }
    };
  });
  return Response.json(
    { id, status: "pending", poll: `/api/chat/image/${id}` },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
}
