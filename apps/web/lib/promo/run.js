import "server-only";

// What a promo job runs, built from what its record keeps (the request and
// who pays), so POST /api/chat/promo and a resume after a restart run the
// very same thing.

import { streamChatCompletion, isNimConfigured } from "@infernetprotocol/nim-adapter";
import { chargeImageJob } from "@/lib/data/interactive-billing";
import { promoPriceMicro } from "@/lib/promo/request";
import { promoJobs } from "@/lib/promo/jobs";
import { promoBrand } from "@/lib/promo/brand";
import { promoGateway } from "@/lib/promo/gateway";
import { runPromo } from "@/lib/promo/pipeline";
import { prepareLogo, renderPromo } from "@/lib/promo/assemble";

export function videoConfig(env = process.env) {
  const num = (k, d) => (Number.isFinite(Number(env[k])) && Number(env[k]) > 0 ? Math.floor(Number(env[k])) : d);
  return {
    enabled: env.PROMO_VIDEO !== "0",
    model: env.PROMO_VIDEO_MODEL || "wan2.2-ti2v-5b",
    width: num("PROMO_VIDEO_WIDTH", 832),
    height: num("PROMO_VIDEO_HEIGHT", 480),
    steps: num("PROMO_VIDEO_STEPS", 20),
    budgetMs: num("PROMO_MOTION_BUDGET_S", 20 * 60) * 1000,
    // The first clip only asks whether a video worker is there at all: a free one
    // takes it within seconds, so no answer in 3 min means Ken Burns, not a slot held 20 min.
    probeMs: num("PROMO_VIDEO_PROBE_S", 3 * 60) * 1000
  };
}

/** `billing` = { mode, userId }: a "balance" caller pays for the work it took. */
export function promoRunner(request, billing = {}) {
  return async (job) => {
    const result = await runPromo(job, request, {
      brand: promoBrand,
      prepareLogo,
      render: renderPromo,
      gateway: promoGateway,
      stream: streamChatCompletion,
      configured: isNimConfigured(),
      video: videoConfig()
    });
    if (billing?.mode === "balance" && billing.userId) {
      const costMicro = promoPriceMicro({ frames: result.frames, music: result.music, clips: result.clips });
      // Keyed by the job id on the ledger: a resumed job never charges twice.
      const charge = await chargeImageJob({ userId: billing.userId, jobId: job.id, costMicro });
      job.meta = { ...job.meta, charged_usd: charge?.charged ? charge.charged_usd : null };
    }
    return result;
  };
}

/** Carry on with every promo a restarted (or dead) process left pending. */
export function resumePromos() {
  return promoJobs.resumeAll((rec) => promoRunner(rec.request, rec.billing));
}
