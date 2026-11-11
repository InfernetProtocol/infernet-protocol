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
  it("defaults to a text-only Wan 2.1 1.3B clip", () => {
    expect(validateVideoRequest({ prompt: " a lighthouse at dusk " })).toEqual({ ok: true, spec: { model: VIDEO_MODEL, prompt: "a lighthouse at dusk" } });
    expect(validateVideoRequest({ prompt: "x", seed: 7, negative_prompt: " blurry " }).spec).toMatchObject({ seed: 7, negative_prompt: "blurry" });
  });

  it("rejects junk, unknown models and image inputs", () => {
    expect(validateVideoRequest({ prompt: "" }).ok).toBe(false);
    expect(validateVideoRequest({ prompt: "x".repeat(2001) }).ok).toBe(false);
    expect(validateVideoRequest({ prompt: "x", model: "nope" }).ok).toBe(false);
    expect(validateVideoRequest({ prompt: "x", image_base64: "AAAA" }).ok).toBe(false);
    expect(validateVideoRequest({ prompt: "x", seed: -1 }).ok).toBe(false);
    expect(validateVideoRequest(null).ok).toBe(false);
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
