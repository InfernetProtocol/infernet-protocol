import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";
import { resolveBillingCaller, authorizeInteractive } from "@/lib/data/interactive-billing";
import { consumeFreeQuery, consumeOperatorSong } from "@/lib/data/free-tier";
import { freeLimitMessage, songLimitMessage } from "@/lib/billing/free-tier";
import { MUSIC_MODEL, musicPriceMicro } from "@/lib/billing/music";
import { validateAlbumRequest } from "@/lib/billing/album";
import { albumJobs } from "@/lib/chat/album-jobs";
import { albumRunner } from "@/lib/chat/album-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An album holds music workers for an hour or more: one or two an hour per
// stranger, on top of the daily free allowance each track spends.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 2 });

/**
 * POST /api/chat/album  { prompt, tracks?: 2..12 (default 8), duration?: 10..180 }
 * → 202 { id, poll }. The server names a band, an album and its songs,
 * writes every song's lyrics, draws a cover, then renders each track as a
 * /music song on c0mpute workers. Poll GET /api/chat/album/<id> for the plan
 * and each track's progress (each finished track plays from
 * /api/chat/music/<track id>), then GET /api/chat/album/<id>/zip.
 * Every track is billed like one /music song: free callers spend one free
 * query per track (an album shrinks to what is left), paying callers a flat
 * per-track price as each track finishes.
 */
export async function POST(request) {
  if (!speechGateway()) return errorJson("Music generation is not configured", 503);
  if (Number(request.headers.get("content-length") ?? 0) > 256 * 1024) return errorJson("Album request is too large", 413);
  let body;
  try {
    const bytes = await readLimitedBody(request, 256 * 1024);
    if (!bytes) return errorJson("Album request is too large", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorJson("Invalid JSON body", 400);
  }
  const parsed = validateAlbumRequest(body);
  if (!parsed.ok) return errorJson(parsed.error, 400);
  const albumRequest = { ...parsed.request };

  const ip = getClientIp(request);
  const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
  const payer = await resolveBillingCaller(request, { trusted });
  const billing = await authorizeInteractive({ userId: payer.userId, model: MUSIC_MODEL });
  if (billing.mode === "insufficient") {
    return errorJson("Out of compute balance", 402, `spendable ${billing.spendable_usd} USD`);
  }
  let limited = false;
  if (billing.mode === "balance") {
    const pr = paidLimit.check(`paid:${payer.userId}`);
    if (!pr.ok) return errorJson("Rate limit exceeded — try again later", 429);
    const need = albumRequest.tracks * musicPriceMicro();
    if (Number.isFinite(billing.spendable_micro) && billing.spendable_micro < need) {
      return errorJson("Out of compute balance", 402, `an album of ${albumRequest.tracks} tracks needs ${(need / 1e6).toFixed(6)} USD, spendable ${billing.spendable_usd} USD`);
    }
  } else {
    const burst = limit.check(ip);
    if (!burst.ok) return errorJson("Album rate limit exceeded — try again later", 429);
    // One free query (and, for node operators, one free song) per track.
    let granted = 0;
    let lastFail = null;
    for (let i = 0; i < albumRequest.tracks; i++) {
      const song = await consumeOperatorSong({ userId: payer.userId ?? null });
      if (song.applies && !song.ok) {
        lastFail = songLimitMessage(song.limit);
        break;
      }
      const free = await consumeFreeQuery({
        userId: payer.userId ?? null,
        clientSubject: payer.subject ?? null,
        ip,
        fingerprint: request.headers.get("x-fingerprint"),
        userAgent: request.headers.get("user-agent")
      });
      if (!free.ok) {
        lastFail = freeLimitMessage(free.limit, free);
        break;
      }
      granted++;
    }
    if (granted < 2) return errorJson(lastFail ?? "Not enough free queries left today for an album", 429);
    if (granted < albumRequest.tracks) {
      albumRequest.tracks = granted;
      limited = true;
    }
  }

  const billingRecord = { mode: billing.mode, userId: payer.userId ?? null };
  const id = albumJobs.start(albumRunner(albumRequest, billingRecord), { request: albumRequest, billing: billingRecord });
  return Response.json(
    { id, status: "pending", tracks: albumRequest.tracks, ...(limited ? { limited: true } : {}), poll: `/api/chat/album/${id}` },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
}
