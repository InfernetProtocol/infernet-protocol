import "server-only";

// Long /video clips: plan the shots, render each on a c0mpute video worker,
// cut them into one MP4. Runs on a durable registry (the promo one, its own
// `clip` kind in the media store): the request, the plan and every finished
// shot are checkpointed as they land, so a deploy mid-clip resumes from the
// next shot instead of losing 30 minutes of GPU time.

import os from "node:os";
import path from "node:path";
import { writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

import { streamChatCompletion, isNimConfigured } from "@infernetprotocol/nim-adapter";
import { createDurableJobs, ttlFromEnv } from "@/lib/chat/durable-jobs";
import { mediaStore } from "@/lib/chat/media-store";
import { runGatewayJob, gatewayError, fetchSpeechGateway } from "@/lib/chat/speech-service";
import { chargeImageJob } from "@/lib/data/interactive-billing";
import { createPromoRegistry } from "@/lib/promo/jobs";
import { ffmpegBin, run, probeSeconds } from "@/lib/promo/assemble";
import { passthroughStatus, videoPriceMicro } from "@/lib/billing/video";
import { SHOT_MODELS, musicCaption, shotNegative, shotPrompt, shotSize, shotSteps, writePlan } from "@/lib/video/shots";

const g = globalThis;
g.__infernetClipDurable ??= createDurableJobs({ kind: "clip", store: () => mediaStore(), ttlMs: ttlFromEnv() });
g.__infernetClipJobs ??= createPromoRegistry({ root: path.join(os.tmpdir(), "infernet-clip"), durable: g.__infernetClipDurable });
export const clipJobs = g.__infernetClipJobs;

/** How many long clips one process runs at once (they queue on the gateway anyway). */
export function clipMaxRunning(env = process.env) {
  const n = Number(env.CLIP_MAX_RUNNING);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 6;
}

/** Gateway request id of shot `i` (attempt `a`): stable, so a resume collects what the gateway kept. */
export const shotRequestId = (jobId, i, a = 0) => `${jobId}-s${i}${a ? `-r${a}` : ""}`;

const cancelled = () => Object.assign(new Error("Cancelled"), { status: 410 });

/** Concatenate the shots (re-encoded, same size and rate) into one H.264 MP4. */
export function concatArgs({ shots, out, width, height, fps, threads = 4 }) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const s of shots) args.push("-i", s);
  const norm = shots
    .map((_, i) => `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`)
    .join(";");
  const cat = `${shots.map((_, i) => `[v${i}]`).join("")}concat=n=${shots.length}:v=1:a=0[out]`;
  args.push("-filter_complex", `${norm};${cat}`, "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-threads", String(threads), out);
  return args;
}

/** Put an audio track under the video: trimmed to the video, faded out over the last 1.5 s, AAC. */
export function muxArgs({ video, audio, out, duration }) {
  const d = Math.max(1, Number(duration) || 1);
  const fadeAt = Math.max(0, d - 1.5).toFixed(2);
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", video, "-i", audio,
    "-filter_complex", `[1:a]atrim=0:${d.toFixed(2)},afade=t=in:st=0:d=0.8,afade=t=out:st=${fadeAt}:d=1.5,volume=0.9[a]`,
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out
  ];
}

/**
 * The work of one clip. `request` = { prompt, subject, model, seconds, shots,
 * vertical, adult?, seed?, negative_prompt? }; `billing` = { mode, userId }.
 */
export function clipRunner(request, billing = {}) {
  return async (job) => {
    const ck = job.checkpoint;
    const total = request.shots;
    const set = (stage, extra = {}) => {
      job.meta = { ...job.meta, stage, shots: total, shots_done: (ck.done ?? []).length, ...extra };
    };
    const saveCk = async () => {
      try {
        await job.checkpointed?.();
      } catch {}
    };

    // 1. The plan.
    if (!ck.plan) {
      set("planning the shots");
      const { plan, writer } = await writePlan(
        { subject: request.subject, shots: total, vertical: request.vertical },
        { stream: streamChatCompletion, configured: isNimConfigured() }
      );
      ck.plan = plan;
      ck.writer = writer;
      await saveCk();
    }
    const plan = ck.plan;
    job.meta = { ...job.meta, plan: { subjects: plan.subjects, shots: plan.shots } };

    // 2. The shots, in order (one GPU worker takes them one at a time anyway).
    const { width, height } = request.size ?? shotSize(request.vertical);
    const { frames, fps } = SHOT_MODELS[request.model] ?? { frames: 121, fps: 24 };
    const baseSeed = Number.isInteger(request.seed) ? request.seed : (ck.seed ??= Math.floor(Math.random() * 2 ** 31));
    ck.done ??= [];
    const failures = [];
    for (let i = 0; i < total; i++) {
      if (job.cancelRequested) throw cancelled();
      const file = path.join(job.dir, `shot-${i}.mp4`);
      if (ck.done.includes(i) && existsSync(file)) continue;
      const spec = {
        model: request.model,
        prompt: shotPrompt(plan, i, { subject: request.subject }),
        negative_prompt: shotNegative(plan, { subject: request.subject, extra: request.negative_prompt }),
        frames,
        fps,
        width,
        height,
        steps: request.steps ?? shotSteps(),
        seed: (baseSeed + i * 7919) % 4294967296,
        ...(request.adult ? { adult: true } : {})
      };
      let ok = false;
      let lastError = null;
      for (let a = 0; a < 2 && !ok; a++) {
        if (job.cancelRequested) throw cancelled();
        const requestId = shotRequestId(job.id, i, a);
        job.currentRequest = requestId;
        set(`shot ${i + 1} of ${total}: queued`);
        try {
          const r = await runGatewayJob("/v1/videos", spec, {
            requestId,
            resume: Boolean(job.resumed),
            onProgress: (p) =>
              set(`shot ${i + 1} of ${total}: ${p.stage}`, {
                detail: typeof p.detail === "string" ? p.detail.slice(0, 200) : undefined,
                queue_position: Number.isFinite(p.queue_position) ? p.queue_position : undefined,
                eta_s: Number.isFinite(p.eta_s) ? p.eta_s + (total - i - 1) * (ck.shotSeconds ?? 360) : undefined
              })
          });
          if (job.cancelRequested) throw cancelled();
          if (r.status !== 200) {
            const why = gatewayError(r) || `video worker failed (HTTP ${r.status})`;
            // A policy refusal or bad request will refuse every shot the same way.
            if ([400, 403, 422].includes(r.status)) throw Object.assign(new Error(why), { status: passthroughStatus(r.status), fatal: true });
            throw Object.assign(new Error(why), { status: passthroughStatus(r.status) });
          }
          const bytes = Buffer.from(r.body);
          await writeFile(file, bytes);
          await job.saveArtifact?.(`shot-${i}.mp4`, bytes);
          ck.done.push(i);
          const took = (Date.now() - (job.shotStarted ?? job.createdAt)) / 1000;
          ck.shotSeconds = Math.round(ck.shotSeconds ? (ck.shotSeconds + took) / 2 : took);
          job.shotStarted = Date.now();
          await saveCk();
          ok = true;
        } catch (e) {
          if (e?.status === 410 || job.cancelRequested) throw cancelled();
          if (e?.fatal) throw e;
          lastError = e;
          console.warn(`[clip] job ${job.id} shot ${i + 1}/${total} attempt ${a + 1}: ${e?.message ?? e}`);
        }
      }
      if (!ok) {
        failures.push(i);
        // Nothing rendered at all after the first two shots: the network has no worker for it.
        if (ck.done.length === 0 && failures.length >= 2) {
          throw Object.assign(new Error(lastError?.message || "No c0mpute video worker rendered the clip; try again in a few minutes"), {
            status: Number(lastError?.status) || 503
          });
        }
      }
    }
    job.currentRequest = null;
    const shots = [...ck.done].sort((a, b) => a - b).map((i) => path.join(job.dir, `shot-${i}.mp4`)).filter((f) => existsSync(f));
    if (!shots.length) throw Object.assign(new Error("No shot of the clip rendered; try again in a few minutes"), { status: 503 });
    if (shots.length < Math.ceil(total / 2)) {
      throw Object.assign(new Error(`Only ${shots.length} of ${total} shots rendered; try again in a few minutes`), { status: 503 });
    }

    // 3. Cut them together.
    set("cutting the shots together");
    const silent = path.join(job.dir, "clip-silent.mp4");
    await run(ffmpegBin(), concatArgs({ shots, out: silent, width, height, fps, threads: Number(process.env.PROMO_FFMPEG_THREADS) || 4 }), { timeoutMs: 10 * 60 * 1000 });
    const duration = (await probeSeconds(silent)) ?? shots.length * ((frames - 1) / fps);

    // 4. A soundtrack (ACE-Step on a c0mpute music worker), mixed in. Optional:
    //    no music worker in time (CLIP_MUSIC_WAIT_S, default 15 min) = the silent cut.
    const out = path.join(job.dir, "clip.mp4");
    let music = null;
    if (process.env.CLIP_MUSIC !== "0") {
      const musicFile = path.join(job.dir, "music.audio");
      if (ck.music && existsSync(musicFile)) music = musicFile;
      else {
        set("writing the soundtrack");
        try {
          const r = await runGatewayJob(
            "/v1/music",
            { prompt: musicCaption(plan, request.subject), lyrics: "", duration: Math.ceil(duration) + 2, model: "ace-step-1.5", seed: baseSeed % 4294967296 },
            { requestId: `${job.id}-music`, resume: Boolean(job.resumed), maxWaitS: Number(process.env.CLIP_MUSIC_WAIT_S) || 15 * 60 }
          );
          if (r.status === 200 && r.body?.length) {
            await writeFile(musicFile, Buffer.from(r.body));
            await job.saveArtifact?.("music.audio", Buffer.from(r.body));
            ck.music = true;
            await saveCk();
            music = musicFile;
          } else console.warn(`[clip] job ${job.id} soundtrack: gateway HTTP ${r.status}`);
        } catch (e) {
          console.warn(`[clip] job ${job.id} soundtrack failed: ${e?.message ?? e}`);
        }
      }
    }
    if (music) {
      set("mixing the soundtrack");
      try {
        await run(ffmpegBin(), muxArgs({ video: silent, audio: music, out, duration }), { timeoutMs: 5 * 60 * 1000 });
      } catch (e) {
        console.warn(`[clip] job ${job.id} mix failed: ${e?.message ?? e}`);
        music = null;
      }
    }
    if (!music) await writeFile(out, await readFile(silent));
    const bytes = (await stat(out)).size;

    // 4. Bill what rendered: one clip price per shot, once per job (the ledger is keyed by the job id).
    let charged = null;
    if (billing?.mode === "balance" && billing.userId) {
      const charge = await chargeImageJob({ userId: billing.userId, jobId: job.id, costMicro: shots.length * videoPriceMicro() });
      charged = charge?.charged ? charge.charged_usd : null;
    }
    set("done", { charged_usd: charged, missing_shots: failures.length || undefined });
    return { video: out, duration, bytes, shots: shots.length, music: Boolean(music), model: request.model, adult: Boolean(request.adult), width, height };
  };
}

/** Start a long clip; returns its id. */
export function startClip(request, billing) {
  return clipJobs.start(clipRunner(request, billing), { request, billing });
}

/** Carry on with the clips a restarted process left pending. */
export function resumeClips() {
  return clipJobs.resumeAll((rec) => clipRunner(rec.request, rec.billing), { maxRunning: clipMaxRunning() });
}

/** Stop a clip here and on the gateway. Returns the job, or null when unknown. */
export async function cancelClip(id) {
  const job = await clipJobs.find(id);
  if (!job) return null;
  if (job.status !== "pending") return job;
  job.cancelRequested = true;
  const ids = new Set();
  if (job.currentRequest) ids.add(job.currentRequest);
  const total = job.request?.shots ?? job.meta?.shots ?? 0;
  for (let i = 0; i < total; i++) for (let a = 0; a < 2; a++) ids.add(shotRequestId(id, i, a));
  ids.add(`${id}-music`);
  await Promise.all(
    [...ids].map((rid) =>
      fetchSpeechGateway(`/v1/result/${encodeURIComponent(rid)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) })
        .then((res) => res?.body?.cancel().catch(() => {}))
        .catch(() => {})
    )
  );
  return job;
}

/** The finished MP4's bytes, from this process or the media store. */
export async function clipBytes(job) {
  const local = job.result?.video && existsSync(job.result.video) ? job.result.video : await clipJobs.file(job, "promo.mp4");
  return local ? readFile(local) : null;
}
