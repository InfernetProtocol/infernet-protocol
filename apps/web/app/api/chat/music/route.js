import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";
import { resolveBillingCaller, authorizeInteractive } from "@/lib/data/interactive-billing";
import { consumeFreeQuery, consumeOperatorSong } from "@/lib/data/free-tier";
import { freeLimitMessage, songLimitMessage } from "@/lib/billing/free-tier";
import { MUSIC_MODEL, validateMusicRequest } from "@/lib/billing/music";
import { startMusicJob } from "@/lib/chat/music-jobs";
import { musicRunner } from "@/lib/chat/music-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One track holds a whole worker for minutes, so strangers get a tight burst
// budget on top of the daily free allowance.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 4 });
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
    // A qualifying node operator has 100 free queries, not 100 free songs: a
    // free song also spends one from their daily song counter. Anyone else is
    // unaffected (applies: false) and pays one free query per song as before.
    const song = await consumeOperatorSong({ userId: payer.userId ?? null });
    if (song.applies && !song.ok) return errorJson(songLimitMessage(song.limit), 429);
    const free = await consumeFreeQuery({
      userId: payer.userId ?? null,
      clientSubject: payer.subject ?? null,
      ip,
      fingerprint: request.headers.get("x-fingerprint"),
      userAgent: request.headers.get("user-agent")
    });
    if (!free.ok) return errorJson(freeLimitMessage(free.limit, free), 429);
  }

  // The record keeps the request and who pays, so a deploy mid-song
  // resumes it (lib/chat/music-run.js resumeSongs) instead of losing it.
  const billingRecord = { mode: billing.mode, userId: payer.userId ?? null };
  const id = startMusicJob(musicRunner(parsed.request, billingRecord), { request: parsed.request, billing: billingRecord });
  return Response.json(
    { id, status: "pending", poll: `/api/chat/music/${id}` },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
}
