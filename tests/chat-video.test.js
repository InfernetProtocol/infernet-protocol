import { describe, it, expect } from "vitest";
import {
  DEFAULT_VIDEO_PRICE_MICRO,
  VIDEO_MODEL,
  adultRefusal,
  parseRange,
  passthroughStatus,
  validateVideoRequest,
  videoPriceMicro
} from "@/lib/billing/video";

describe("chat video helpers", () => {
  it("defaults to a 30 s Wan 2.2 5B clip cut from six 5 s shots", () => {
    expect(VIDEO_MODEL).toBe("wan2.2-ti2v-5b");
    const r = validateVideoRequest({ prompt: " a lighthouse at dusk " });
    expect(r.ok).toBe(true);
    expect(r.long).toEqual({ prompt: "a lighthouse at dusk", subject: "a lighthouse at dusk", model: VIDEO_MODEL, seconds: 30, shots: 6, vertical: false });
    expect(validateVideoRequest({ prompt: "x", seed: 7, negative_prompt: " blurry " }).long).toMatchObject({ seed: 7, negative_prompt: "blurry" });
  });

  it("takes the length from the body, else the prompt, clamped to 5-60 s", () => {
    const p = "make a 30 second video of a cat and a dog (realistic) in heavy combat gear";
    expect(validateVideoRequest({ prompt: p }).long).toMatchObject({ seconds: 30, shots: 6, subject: "a cat and a dog (realistic) in heavy combat gear" });
    expect(validateVideoRequest({ prompt: "a 15s clip of rain" }).long).toMatchObject({ seconds: 15, shots: 3 });
    expect(validateVideoRequest({ prompt: "rain", seconds: 10, vertical: true }).long).toMatchObject({ seconds: 10, shots: 2, vertical: true });
    expect(validateVideoRequest({ prompt: "rain", seconds: 500 }).long).toMatchObject({ seconds: 60, shots: 12 });
    expect(validateVideoRequest({ prompt: "rain", seconds: 1 }).long).toMatchObject({ seconds: 5, shots: 1 });
    expect(validateVideoRequest({ prompt: "rain", seconds: "lots" }).ok).toBe(false);
  });

  it("the 1.3B draft is one shot with the fidelity rules applied", () => {
    const r = validateVideoRequest({ prompt: "a cat in armor", model: "wan2.1-t2v-1.3b" });
    expect(r.long).toBeUndefined();
    expect(r.spec.model).toBe("wan2.1-t2v-1.3b");
    expect(r.spec.prompt).toMatch(/^a cat in armor \(real animals, not people\)/);
    expect(r.spec.negative_prompt).toMatch(/human soldier/);
  });

  it("rejects junk, unknown models and image inputs", () => {
    expect(validateVideoRequest({ prompt: "" }).ok).toBe(false);
    expect(validateVideoRequest({ prompt: "x".repeat(2001) }).ok).toBe(false);
    expect(validateVideoRequest({ prompt: "x", model: "nope" }).ok).toBe(false);
    expect(validateVideoRequest({ prompt: "x", image_base64: "AAAA" }).ok).toBe(false);
    expect(validateVideoRequest({ prompt: "x", seed: -1 }).ok).toBe(false);
    expect(validateVideoRequest(null).ok).toBe(false);
  });

  it("chatrxl-uncensored is a ChatrXL first frame animated by Wan 2.2 5B, SFW only", () => {
    const r = validateVideoRequest({ prompt: " a fox in the snow ", model: "chatrxl-uncensored", seed: 9 });
    expect(r).toEqual({
      ok: true,
      spec: { model: "wan2.2-ti2v-5b", prompt: "a fox in the snow", seed: 9 },
      keyframe: { prompt: "a fox in the snow", model: "chatrxl-uncensored", width: 1024, height: 576, steps: 8, seed: 9 }
    });
    expect(validateVideoRequest({ prompt: "x", model: "chatrxl-uncensored", adult: true }).ok).toBe(false);
    expect(validateVideoRequest({ prompt: "x", model: "wan2.2-ti2v-5b" }).keyframe).toBeUndefined();
  });

  it("prices a clip flat, overridable by env", () => {
    expect(videoPriceMicro({})).toBe(DEFAULT_VIDEO_PRICE_MICRO);
    expect(videoPriceMicro({ INFERNET_VIDEO_PRICE_MICRO: "100" })).toBe(100);
  });

  it("adult mode: trusted client on a paid balance only", () => {
    expect(adultRefusal({ adult: false, trusted: null, billingMode: "free" })).toBeNull();
    expect(adultRefusal({ adult: true, trusted: null, billingMode: "balance" }).status).toBe(403);
    expect(adultRefusal({ adult: true, trusted: { id: "c0mpute" }, billingMode: "free" }).status).toBe(402);
    expect(adultRefusal({ adult: true, trusted: { id: "c0mpute" }, billingMode: "balance" })).toBeNull();
    // Admin accounts are unmetered and count as paid; still trusted-client only.
    expect(adultRefusal({ adult: true, trusted: { id: "c0mpute" }, billingMode: "admin" })).toBeNull();
    expect(adultRefusal({ adult: true, trusted: null, billingMode: "admin" }).status).toBe(403);
  });

  it("keeps policy refusal statuses from the gateway", () => {
    expect(passthroughStatus(422)).toBe(422);
    expect(passthroughStatus(403)).toBe(403);
    expect(passthroughStatus(503)).toBe(503);
    expect(passthroughStatus(500)).toBe(502);
  });

  it("parses byte ranges", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=0-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=200-", 100)).toBe(false);
    expect(parseRange("items=0-1", 100)).toBe(false);
  });
});
