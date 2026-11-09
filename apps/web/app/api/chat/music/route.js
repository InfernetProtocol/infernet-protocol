import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { fetchSpeechGateway, postSpeechGatewayLong, readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";
import { resolveBillingCaller, authorizeInteractive, chargeImageJob } from "@/lib/data/interactive-billing";
import { consumeFreeQuery } from "@/lib/data/free-tier";
import { freeLimitMessage } from "@/lib/billing/free-tier";
import { MUSIC_MODEL, coverArtPrompt, musicPriceMicro, toGatewaySpec, validateMusicRequest } from "@/lib/billing/music";
import { writeMusicSpec } from "@/lib/music-brief-writer";
import { setMusicCover, startMusicJob } from "@/lib/chat/music-jobs";
import { IMAGE_MODEL, IMAGE_SIZES } from "@/lib/billing/image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One track holds a whole worker for minutes, so strangers get a tight burst
// budget on top of the daily free allowance.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 4 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST the song to the gateway, retrying what is not the song's fault: the
 * connection dropping (the gateway re-execs itself on every c0mpute
 * auto-update, which cuts in-flight requests: "socket hang up") and 503 (no
 * worker free, or the one that took it was killed). A song job is idempotent.
 */
async function postWithRetries(spec, { attempts = 3, requestId = null, onProgress = null } = {}) {
  let last = null;
  // While the gateway works, read its live stage for this request (which
  // node won, its ETA, queued, retrying) so the chat can show it. Gateways
  // older than c0mpute 0.2.85 answer 404 and the chat keeps its timer.
  const watch = requestId && onProgress ? watchProgress(requestId, onProgress) : null;
  try {
    return await attemptAll();
  } finally {
    watch?.stop();
  }

  async function attemptAll() {
  for (let i = 1; i <= attempts; i++) {
    try {
      // node:http, not fetch: undici gives up on headers after 300 s.
      const response = await postSpeechGatewayLong("/v1/music", spec, {
        timeoutMs: 30 * 60 * 1000,
        headers: requestId ? { "x-request-id": requestId } : {}
      });
      if (!response) throw Object.assign(new Error("Music generation is not configured"), { status: 503, final: true });
      if (response.status !== 503 || i === attempts) return response;
      last = response;
    } catch (error) {
      if (error?.final) throw error;
      console.warn(`[chat/music] gateway attempt ${i} failed: ${error?.message ?? error}`);
      if (i === attempts) {
        throw Object.assign(new Error(`Music generation failed: ${error?.message ?? error}`), { status: 502 });
      }
    }
    onProgress?.({ stage: "retrying", attempt: i + 1, detail: "the gateway connection dropped or no worker was free" });
    await sleep(i * 10_000);
  }
  return last;
  }
}

/**
 * Draw the song's cover on a c0mpute image worker and keep it for
 * GET /api/chat/music/<id>/cover. Resolves true/false; never throws. One
 * retry, for the same dropped-connection reason as the song.
 */
async function makeCover(id, { caption, title }) {
  const body = { prompt: coverArtPrompt({ caption, title }), model: IMAGE_MODEL, ...IMAGE_SIZES.square, steps: 8 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await postSpeechGatewayLong("/v1/images", body, { timeoutMs: 15 * 60 * 1000 });
      if (response?.status === 200 && response.body?.length > 8) {
        setMusicCover(id, new Uint8Array(response.body));
        return true;
      }
      if (response && response.status !== 503) return false;
    } catch (error) {
      console.warn(`[chat/music] cover attempt ${attempt} failed: ${error?.message ?? error}`);
    }
    await sleep(10_000);
  }
  return false;
}

/** Poll the gateway's GET /v1/progress/<id> every 5 s until stopped. */
function watchProgress(requestId, onProgress) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      await sleep(5000);
      if (stopped) break;
      try {
        const res = await fetchSpeechGateway(`/v1/progress/${encodeURIComponent(requestId)}`, {
          signal: AbortSignal.timeout(4000)
        });
        if (res?.ok) {
          const p = await res.json().catch(() => null);
          if (!stopped && p && typeof p.stage === "string") onProgress(p);
        }
      } catch {
        // Progress is best effort; the song request itself decides the outcome.
      }
    }
  })();
  return { stop: () => { stopped = true; } };
}

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
  const id = startMusicJob(async (job) => {
    // A brief with no lyrics becomes a caption + original lyrics + length,
    // so "a rap-rock song about ..." is sung, not an instrumental.
    job.meta = { stage: "writing" };
    const written = await writeMusicSpec(parsed.request);
    const spec = toGatewaySpec({ ...parsed.request, ...written });
    const title = written.title ?? null;
    job.meta = { stage: "composing", caption: spec.prompt, lyrics: spec.lyrics, duration: spec.duration, writer: written.writer, title, cover: "pending" };

    // Cover art, in parallel on the image workers (Z-Image-Turbo, ~2 min):
    // it never delays or fails the song, and is usually ready first.
    makeCover(job.id, { caption: spec.prompt, title }).then((ok) => {
      job.meta = { ...job.meta, cover: ok ? "ready" : "failed" };
    });

    const response = await postWithRetries(spec, {
      requestId: job.id,
      onProgress: (p) => {
        job.meta = {
          ...job.meta,
          node: {
            stage: p.stage,
            worker: typeof p.worker === "string" ? p.worker : undefined,
            eta_s: Number.isFinite(p.eta_s) ? p.eta_s : undefined,
            elapsed_s: Number.isFinite(p.elapsed_s) ? p.elapsed_s : undefined,
            stage_elapsed_s: Number.isFinite(p.stage_elapsed_s) ? p.stage_elapsed_s : undefined,
            attempt: Number.isFinite(p.attempt) ? p.attempt : undefined,
            detail: typeof p.detail === "string" ? p.detail.slice(0, 200) : undefined
          }
        };
      }
    });
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
