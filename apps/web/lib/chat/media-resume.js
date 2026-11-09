import "server-only";

// Resume the promo videos and songs a restarted (or dead) process left
// pending, at most once per RESUME_EVERY_MS however often it is asked.
// instrumentation.js asks on boot and every minute after.

import { resumePromos } from "@/lib/promo/run";
import { resumeSongs } from "@/lib/chat/music-run";

const RESUME_EVERY_MS = 30_000;

export async function resumeMediaJobs({ now = Date.now() } = {}) {
  const g = globalThis;
  if (g.__infernetMediaResume && now - g.__infernetMediaResume.at < RESUME_EVERY_MS) return g.__infernetMediaResume.result;
  const result = (async () => {
    const [promos, songs] = await Promise.all([
      resumePromos().catch((e) => {
        console.warn(`[media] resuming promos failed: ${e?.message ?? e}`);
        return [];
      }),
      resumeSongs().catch((e) => {
        console.warn(`[media] resuming songs failed: ${e?.message ?? e}`);
        return [];
      })
    ]);
    return { promos, songs };
  })();
  g.__infernetMediaResume = { at: now, result };
  return result;
}
