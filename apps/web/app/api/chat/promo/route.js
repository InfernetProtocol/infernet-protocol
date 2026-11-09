import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";
import { resolveBillingCaller, authorizeInteractive, chargeImageJob } from "@/lib/data/interactive-billing";
import { consumeFreeQuery } from "@/lib/data/free-tier";
import { freeLimitMessage } from "@/lib/billing/free-tier";
import { streamChatCompletion, isNimConfigured } from "@infernetprotocol/nim-adapter";
import { PROMO_MODEL, promoPriceMicro, validatePromoRequest } from "@/lib/promo/request";
import { promoJobs } from "@/lib/promo/jobs";
import { promoBrand } from "@/lib/promo/brand";
import { promoGateway } from "@/lib/promo/gateway";
import { runPromo } from "@/lib/promo/pipeline";
import { hasFfmpeg, prepareLogo, renderPromo } from "@/lib/promo/assemble";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A promo holds several workers for minutes and renders here with ffmpeg:
// strangers get two an hour on top of the daily free allowance.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 2 });

function videoConfig(env = process.env) {
  const num = (k, d) => (Number.isFinite(Number(env[k])) && Number(env[k]) > 0 ? Math.floor(Number(env[k])) : d);
  return {
    enabled: env.PROMO_VIDEO !== "0",
    model: env.PROMO_VIDEO_MODEL || "wan2.2-ti2v-5b",
    width: num("PROMO_VIDEO_WIDTH", 832),
    height: num("PROMO_VIDEO_HEIGHT", 480),
    steps: num("PROMO_VIDEO_STEPS", 20),
    budgetMs: num("PROMO_MOTION_BUDGET_S", 20 * 60) * 1000
  };
}

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
  const maxRunning = Number(process.env.PROMO_MAX_RUNNING) > 0 ? Number(process.env.PROMO_MAX_RUNNING) : 3;
  if (promoJobs.running() >= maxRunning) {
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
  if (billing.mode === "balance") {
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

  const userId = payer.userId;
  const chargeMode = billing.mode;
  const id = promoJobs.start(async (job) => {
    const result = await runPromo(job, parsed.request, {
      brand: promoBrand,
      prepareLogo,
      render: renderPromo,
      gateway: promoGateway,
      stream: streamChatCompletion,
      configured: isNimConfigured(),
      video: videoConfig()
    });
    if (chargeMode === "balance") {
      const costMicro = promoPriceMicro({ frames: result.frames, music: result.music, clips: result.clips });
      const charge = await chargeImageJob({ userId, jobId: job.id, costMicro });
      job.meta = { ...job.meta, charged_usd: charge?.charged ? charge.charged_usd : null };
    }
    return result;
  });
  return Response.json(
    { id, status: "pending", poll: `/api/chat/promo/${id}` },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
}
