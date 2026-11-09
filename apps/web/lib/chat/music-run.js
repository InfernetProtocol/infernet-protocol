import "server-only";

// The /chat music job: the gateway calls (song with retries, cover art,
// live progress) and the runner a job record can be resumed with.

import { awaitGatewayResult, fetchSpeechGateway, postSpeechGatewayLong } from "@/lib/chat/speech-service";
import { chargeImageJob } from "@/lib/data/interactive-billing";
import { MUSIC_MODEL, coverArtPrompt, musicPriceMicro, toGatewaySpec } from "@/lib/billing/music";
import { writeMusicSpec } from "@/lib/music-brief-writer";
import { musicJobs, setMusicCover } from "@/lib/chat/music-jobs";
import { IMAGE_MODEL, IMAGE_SIZES } from "@/lib/billing/image";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST the song to the gateway, retrying what is not the song's fault: the
 * connection dropping (the gateway re-execs itself on every c0mpute
 * auto-update, which cuts in-flight requests: "socket hang up") and 503 (no
 * worker free, or the one that took it was killed). A song job is idempotent.
 */
export async function postWithRetries(spec, { attempts = 3, requestId = null, onProgress = null, resume = false } = {}) {
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
  // Resumed after a restart: the gateway may still be making (or have made)
  // this very song under our request id. Collect it rather than start again.
  if (resume && requestId) {
    const kept = await awaitGatewayResult(requestId);
    if (kept?.status === 200) return kept;
  }
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
      // The connection dropped, but a c0mpute >= 0.2.90 gateway keeps the
      // song running under our request id: wait for it instead of starting
      // a second one.
      if (requestId) {
        const kept = await awaitGatewayResult(requestId);
        if (kept) return kept;
      }
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
export async function makeCover(id, { caption, title }, { resume = false } = {}) {
  const body = { prompt: coverArtPrompt({ caption, title }), model: IMAGE_MODEL, ...IMAGE_SIZES.square, steps: 8 };
  const coverId = `${id}-cover`;
  if (resume) {
    const kept = await awaitGatewayResult(coverId, { timeoutMs: 12 * 60 * 1000 }).catch(() => null);
    if (kept?.status === 200 && kept.body?.length > 8) {
      setMusicCover(id, new Uint8Array(kept.body));
      return true;
    }
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let response = await postSpeechGatewayLong("/v1/images", body, {
        timeoutMs: 15 * 60 * 1000,
        headers: { "x-request-id": coverId }
      }).catch(async (error) => {
        console.warn(`[chat/music] cover attempt ${attempt} failed: ${error?.message ?? error}`);
        return awaitGatewayResult(coverId, { timeoutMs: 12 * 60 * 1000 });
      });
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
 * The song job, built from what its record keeps (the request and who
 * pays), so POST /api/chat/music and a resume after a restart run the same
 * thing. Stages are checkpointed on job.checkpoint: the written spec (so a
 * resumed song keeps its lyrics and title) and the cover's outcome.
 */
export function musicRunner(request, billing = {}) {
  return async (job) => {
    const ck = (job.checkpoint ??= {});
    if (!ck.spec) {
      // A brief with no lyrics becomes a caption + original lyrics + length,
      // so "a rap-rock song about ..." is sung, not an instrumental.
      job.meta = { stage: "writing" };
      const written = await writeMusicSpec(request);
      ck.spec = toGatewaySpec({ ...request, ...written });
      ck.title = written.title ?? null;
      ck.writer = written.writer ?? null;
      await job.checkpointed?.();
    }
    const spec = ck.spec;
    const title = ck.title ?? null;
    job.meta = { stage: "composing", caption: spec.prompt, lyrics: spec.lyrics, duration: spec.duration, writer: ck.writer, title, cover: ck.cover ?? "pending" };

    // Cover art, in parallel on the image workers (Z-Image-Turbo, ~2 min):
    // it never delays or fails the song, and is usually ready first.
    if (!ck.cover) {
      makeCover(job.id, { caption: spec.prompt, title }, { resume: Boolean(job.resumed) }).then((ok) => {
        ck.cover = ok ? "ready" : "failed";
        job.meta = { ...job.meta, cover: ck.cover };
        job.checkpointed?.();
      });
    }

    const response = await postWithRetries(spec, {
      requestId: job.id,
      resume: Boolean(job.resumed),
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
    if (billing?.mode === "balance" && billing.userId && UUID.test(jobId)) {
      // Flat per-job charge on the same idempotent ledger key as images, so
      // a resumed song is never charged twice.
      charge = await chargeImageJob({ userId: billing.userId, jobId, costMicro: musicPriceMicro() });
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
  };
}

/** Carry on with every song a restarted (or dead) process left pending. */
export function resumeSongs() {
  return musicJobs.resumeAll((rec) => musicRunner(rec.request ?? {}, rec.billing ?? {}));
}
