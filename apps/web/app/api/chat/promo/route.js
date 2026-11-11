import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";
import { resolveBillingCaller, authorizeInteractive } from "@/lib/data/interactive-billing";
import { consumeFreeQuery } from "@/lib/data/free-tier";
import { freeLimitMessage } from "@/lib/billing/free-tier";
import { PROMO_MODEL, promoPriceMicro, validatePromoRequest } from "@/lib/promo/request";
import { promoJobs, promoMaxRunning } from "@/lib/promo/jobs";
import { promoRunner } from "@/lib/promo/run";
import { hasFfmpeg } from "@/lib/promo/assemble";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A promo holds several workers for minutes and renders here with ffmpeg:
// strangers get two an hour on top of the daily free allowance.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 2 });

/**
 * POST /api/chat/promo  { url, style?, vertical?, brief?, voice?, music? }
 * -> 202 { id, poll }. Poll GET /api/chat/promo/<id> for stages and frames;
 * when it says done, GET .../video (MP4) and .../captions (SRT).
 * Free callers spend one daily free query; callers with a balance pay for the
 * work it took (frames, soundtrack, img2vid clips; see promoPriceMicro).
 */
export async function POST(request) {
  if (!speechGateway()) return errorJson("Promo videos are not configured", 503);
  if (!hasFfmpeg()) return errorJson("Promo videos are not available on this server (no ffmpeg)", 503);
  let body;
  try {
    const bytes = await readLimitedBody(request, 64 * 1024);
    if (!bytes) return errorJson("Promo request is too large", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorJson("Invalid JSON body", 400);
  }
  const parsed = validatePromoRequest(body);
  if (!parsed.ok) return errorJson(parsed.error, 400);
  if (promoJobs.running() >= promoMaxRunning()) {
    return errorJson("Every promo slot is busy; try again in a few minutes", 503);
  }

  const ip = getClientIp(request);
  const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
  const payer = await resolveBillingCaller(request, { trusted });
  const billing = await authorizeInteractive({ userId: payer.userId, model: PROMO_MODEL });
  const estimate = promoPriceMicro({ frames: 8, music: parsed.request.music, clips: 0 });
  if (billing.mode === "insufficient" || (billing.mode === "balance" && billing.spendable_micro < estimate)) {
    return errorJson("Out of compute balance", 402, `a promo costs about ${(estimate / 1e6).toFixed(3)} USD; spendable ${billing.spendable_usd} USD`);
  }
  if (billing.mode === "balance" || billing.mode === "admin") {
    const pr = paidLimit.check(`paid:${payer.userId}`);
    if (!pr.ok) return errorJson("Rate limit exceeded, try again later", 429);
  } else {
    const burst = limit.check(ip);
    if (!burst.ok) return errorJson("Promo rate limit exceeded, try again later", 429);
    const free = await consumeFreeQuery({
      userId: payer.userId ?? null,
      clientSubject: payer.subject ?? null,
      ip,
      fingerprint: request.headers.get("x-fingerprint"),
      userAgent: request.headers.get("user-agent")
    });
    if (!free.ok) return errorJson(freeLimitMessage(free.limit, free), 429);
  }

  // The record keeps the request and who pays, so a deploy mid-promo
  // resumes it (lib/promo/run.js resumePromos) instead of losing it.
  const billingRecord = { mode: billing.mode, userId: payer.userId ?? null };
  const id = promoJobs.start(promoRunner(parsed.request, billingRecord), { request: parsed.request, billing: billingRecord });
  return Response.json(
    { id, status: "pending", poll: `/api/chat/promo/${id}` },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
}
