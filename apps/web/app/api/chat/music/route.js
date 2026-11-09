import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { postSpeechGatewayLong, readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";
import { resolveBillingCaller, authorizeInteractive, chargeImageJob } from "@/lib/data/interactive-billing";
import { consumeFreeQuery } from "@/lib/data/free-tier";
import { freeLimitMessage } from "@/lib/billing/free-tier";
import { MUSIC_MODEL, musicPriceMicro, validateMusicRequest } from "@/lib/billing/music";
import { startMusicJob } from "@/lib/chat/music-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One track holds a whole worker for minutes, so strangers get a tight burst
// budget on top of the daily free allowance.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 4 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg"]);

/**
 * POST /api/chat/music  { prompt, lyrics?, duration?: 10..120, seed? }
 * → 202 { id, poll }. Poll GET /api/chat/music/<id> for the audio, which a
 * c0mpute worker generates with ACE-Step 1.5 through the same gateway as voice
 * and images. No lyrics = instrumental. Free callers spend one of their daily
 * free queries; signed-in callers with a balance pay a flat per-track price.
 */
export async function POST(request) {
  if (!speechGateway()) return errorJson("Music generation is not configured", 503);
  // 100k characters of prompt plus 100k of lyrics, UTF-8, with room to spare.
  if (Number(request.headers.get("content-length") ?? 0) > 1024 * 1024) {
    return errorJson("Music request is too large", 413);
  }
  let body;
  try {
    const bytes = await readLimitedBody(request, 1024 * 1024);
    if (!bytes) return errorJson("Music request is too large", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorJson("Invalid JSON body", 400);
  }
  const parsed = validateMusicRequest(body);
  if (!parsed.ok) return errorJson(parsed.error, 400);

  const ip = getClientIp(request);
  const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
  const payer = await resolveBillingCaller(request, { trusted });
  const billing = await authorizeInteractive({ userId: payer.userId, model: MUSIC_MODEL });
  if (billing.mode === "insufficient") {
    return errorJson("Out of compute balance", 402, `spendable ${billing.spendable_usd} USD`);
  }
  if (billing.mode === "balance") {
    const pr = paidLimit.check(`paid:${payer.userId}`);
    if (!pr.ok) return errorJson("Rate limit exceeded — try again later", 429);
  } else {
    const burst = limit.check(ip);
    if (!burst.ok) return errorJson("Music rate limit exceeded — try again later", 429);
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
  const id = startMusicJob(async () => {
    let response;
    try {
      // node:http, not fetch: undici gives up on headers after 300 s.
      response = await postSpeechGatewayLong("/v1/music", parsed.spec, { timeoutMs: 19 * 60 * 1000 });
    } catch (error) {
      throw Object.assign(new Error(`Music generation failed: ${error?.message ?? error}`), { status: 502 });
    }
    if (!response) throw Object.assign(new Error("Music generation is not configured"), { status: 503 });
    if (response.status !== 200) {
      const busy = response.status === 503;
      throw Object.assign(
        new Error(busy ? "No c0mpute music worker is free right now — try again in a few minutes" : "Music generation failed"),
        { status: busy ? 503 : 502 }
      );
    }
    const header = (name) => {
      const v = response.headers[name];
      return Array.isArray(v) ? v[0] ?? "" : v ?? "";
    };
    const type = header("content-type").split(";")[0].trim().toLowerCase();
    const contentType = AUDIO_TYPES.has(type) ? type : "audio/mpeg";
    const jobId = header("x-c0mpute-job-id");
    const worker = header("x-c0mpute-worker-peer-id");
    let charge = null;
    if (chargeMode === "balance" && UUID.test(jobId)) {
      // Flat per-job charge on the same idempotent ledger key as images.
      charge = await chargeImageJob({ userId, jobId, costMicro: musicPriceMicro() });
    }
    return {
      audio: new Uint8Array(response.body),
      contentType,
      headers: {
        "x-music-model": MUSIC_MODEL,
        ...(jobId ? { "x-c0mpute-job-id": jobId } : {}),
        ...(worker ? { "x-c0mpute-worker-peer-id": worker } : {}),
        ...(charge?.charged ? { "x-charged-usd": charge.charged_usd } : {})
      }
    };
  });
  return Response.json(
    { id, status: "pending", poll: `/api/chat/music/${id}` },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
}
