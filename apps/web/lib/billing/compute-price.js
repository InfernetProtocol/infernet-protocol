// Media jobs priced by the compute they used (Anthony 2026-11-28: "if our cost
// is 18 cents/hour we should be charging 36 cents/hour").
//
//   price = max(floor, MARKUP x card $/hour x busy seconds / 3600)
//
// Busy seconds run from when a worker starts rendering (the gateway's progress
// leaves the queued stage) to when the result arrives, so time waiting in the
// queue is never billed. The card rate is what renting that class of GPU costs
// us (Vast, 2026-11-28): 24 GB video cards ~$0.184/h, a 12 GB card ~$0.087/h.
// The floor keeps every job at least its old flat price.

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export const DEFAULT_MARKUP = 2;
export const DEFAULT_HOURLY_USD = Object.freeze({ video: 0.184, image: 0.087, music: 0.087, tts: 0.087 });
export const DEFAULT_FLOOR_MICRO = Object.freeze({ video: 25000, image: 2000, music: 5000, tts: 0 });

export function computeRates(env = process.env) {
  const markup = num(env?.INFERNET_COMPUTE_MARKUP, DEFAULT_MARKUP);
  const hourly = {};
  const floor = {};
  for (const k of Object.keys(DEFAULT_HOURLY_USD)) {
    hourly[k] = num(env?.[`INFERNET_${k.toUpperCase()}_GPU_HOUR_USD`], DEFAULT_HOURLY_USD[k]);
    floor[k] = Math.floor(num(env?.[`INFERNET_${k.toUpperCase()}_PRICE_MICRO`], DEFAULT_FLOOR_MICRO[k]));
  }
  return { markup, hourly, floor };
}

/** Micro-USD for `seconds` of busy compute on a `kind` job (video|image|music|tts). */
export function computePriceMicro(kind, seconds, env = process.env) {
  const { markup, hourly, floor } = computeRates(env);
  const rate = hourly[kind] ?? hourly.image;
  const busy = Math.max(0, Number(seconds) || 0);
  return Math.max(floor[kind] ?? 0, Math.ceil(markup * rate * (busy / 3600) * 1e6));
}

/** Expected price before a job runs (for the balance check), from a typical run time. */
export function estimatePriceMicro(kind, typicalSeconds, env = process.env) {
  return computePriceMicro(kind, typicalSeconds, env);
}

const QUEUED = /^(queued|pending|waiting|submitted|starting)\b/i;

/**
 * Measures busy time from the gateway's progress events. Wrap the job's
 * onProgress with `meter.wrap(fn)`; `meter.seconds()` after the result is the
 * time since the first non-queued stage (or since start when no progress came).
 */
export function busyMeter(now = () => Date.now()) {
  const started = now();
  let renderAt = null;
  return {
    wrap(inner) {
      return (p) => {
        const stage = String(p?.stage ?? "");
        if (renderAt === null && stage && !QUEUED.test(stage)) {
          // elapsed_s on the event is time in this stage; back-date to when it began.
          const inStage = Number(p?.stage_elapsed_s);
          renderAt = now() - (Number.isFinite(inStage) && inStage > 0 ? inStage * 1000 : 0);
        }
        inner?.(p);
      };
    },
    seconds() {
      return Math.max(0, (now() - (renderAt ?? started)) / 1000);
    },
  };
}
