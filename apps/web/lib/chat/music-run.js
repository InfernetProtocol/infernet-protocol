import "server-only";

// The /chat music job: the gateway calls (song with retries, cover art,
// live progress) and the runner a job record can be resumed with.

import { runGatewayJob, gatewayError } from "@/lib/chat/speech-service";
import { chargeImageJob } from "@/lib/data/interactive-billing";
import { MUSIC_MODEL, coverArtPrompt, musicPriceMicro, toGatewaySpec } from "@/lib/billing/music";
import { writeMusicSpec } from "@/lib/music-brief-writer";
import { musicJobs, setMusicCover } from "@/lib/chat/music-jobs";
import { IMAGE_MODEL, IMAGE_SIZES } from "@/lib/billing/image";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The song on the gateway. It waits in the gateway's queue for a free music
 * worker (up to 2 h) rather than failing, survives the gateway restarting
 * (same request id), and is never posted twice while the gateway has it,
 * so a queued song burns no retries and is charged once, on completion.
 */
export async function postWithRetries(spec, { requestId = null, onProgress = null, resume = false } = {}) {
  return runGatewayJob("/v1/music", spec, {
    requestId: requestId ?? `song-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    onProgress,
    resume
  });
}

/**
 * Draw the song's cover on a c0mpute image worker and keep it for
 * GET /api/chat/music/<id>/cover. Resolves true/false; never throws. It
 * queues like the song does.
 */
export async function makeCover(id, { caption, title }, { resume = false } = {}) {
  const body = { prompt: coverArtPrompt({ caption, title }), model: IMAGE_MODEL, ...IMAGE_SIZES.square, steps: 8 };
  try {
    const response = await runGatewayJob("/v1/images", body, { requestId: `${id}-cover`, resume });
    if (response?.status === 200 && response.body?.length > 8) {
      setMusicCover(id, new Uint8Array(response.body));
      return true;
    }
  } catch (error) {
    console.warn(`[chat/music] cover failed: ${error?.message ?? error}`);
  }
  return false;
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
      // An album track keeps the title the album planner gave it.
      ck.title = request.title ?? written.title ?? null;
      ck.writer = written.writer ?? null;
      await job.checkpointed?.();
    }
    const spec = ck.spec;
    const title = ck.title ?? null;
    // Album tracks (cover: false) share the album's cover instead of one each.
    const wantsCover = request.cover !== false;
    job.meta = { stage: "composing", caption: spec.prompt, lyrics: spec.lyrics, duration: spec.duration, writer: ck.writer, title, cover: wantsCover ? ck.cover ?? "pending" : "none" };

    // Cover art, in parallel on the image workers (Z-Image-Turbo, ~2 min):
    // it never delays or fails the song, and is usually ready first.
    if (wantsCover && !ck.cover) {
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
      // 503 now means the gateway's whole queue wait ran out with no worker.
      throw Object.assign(new Error(gatewayError(response) || "Music generation failed"), {
        status: response.status === 503 ? 503 : 502
      });
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
