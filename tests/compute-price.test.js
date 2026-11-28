import { describe, it, expect } from "vitest";
import { busyMeter, computePriceMicro, computeRates } from "@/lib/billing/compute-price";

describe("media priced at 2x our compute cost", () => {
  it("a Wan 2.2 5B shot (~11 min on a $0.184/h card) costs 2x that", () => {
    // 660 s x $0.184/h x 2 = $0.06746
    expect(computePriceMicro("video", 660, {})).toBe(67467);
    // A 30 s clip = 6 shots ~ $0.40.
    expect(6 * computePriceMicro("video", 660, {})).toBeGreaterThan(400000);
  });

  it("never below the old flat price, and longer runs cost more", () => {
    expect(computePriceMicro("image", 5, {})).toBe(2000);
    expect(computePriceMicro("music", 1, {})).toBe(5000);
    expect(computePriceMicro("image", 600, {})).toBeGreaterThan(computePriceMicro("image", 60, {}));
    expect(computePriceMicro("video", 0, {})).toBe(25000);
  });

  it("rates and markup are env-configurable", () => {
    expect(computeRates({ INFERNET_COMPUTE_MARKUP: "3", INFERNET_VIDEO_GPU_HOUR_USD: "0.268" })).toMatchObject({ markup: 3, hourly: { video: 0.268 } });
    expect(computePriceMicro("video", 3600, { INFERNET_COMPUTE_MARKUP: "2", INFERNET_VIDEO_GPU_HOUR_USD: "0.268", INFERNET_VIDEO_PRICE_MICRO: "0" })).toBe(536000);
  });

  it("bills from when rendering starts, never the queue", () => {
    let t = 0;
    const m = busyMeter(() => t);
    const on = m.wrap(() => {});
    t = 600_000; on({ stage: "queued" });
    t = 900_000; on({ stage: "rendering", stage_elapsed_s: 10 });
    t = 1_500_000;
    expect(m.seconds()).toBe(610);
    const none = busyMeter(() => t);
    t = 1_560_000;
    expect(none.seconds()).toBe(60);
  });
});
