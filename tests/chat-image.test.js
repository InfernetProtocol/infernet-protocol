import { describe, it, expect } from "vitest";
import {
  DEFAULT_IMAGE_PRICE_MICRO,
  IMAGE_MODEL,
  imagePriceMicro,
  parseImageCommand,
  validateImageRequest
} from "@/lib/billing/image";

describe("chat image helpers", () => {
  it("parses /image, /img and /draw commands only", () => {
    expect(parseImageCommand("/image a red bicycle")).toBe("a red bicycle");
    expect(parseImageCommand("  /IMG  fox at dusk ")).toBe("fox at dusk");
    expect(parseImageCommand("/draw\na cat")).toBe("a cat");
    expect(parseImageCommand("draw me a cat")).toBeNull();
    expect(parseImageCommand("/image")).toBeNull();
  });

  it("defaults to a landscape 768x512 Z-Image-Turbo job", () => {
    const r = validateImageRequest({ prompt: " a lighthouse " });
    expect(r).toEqual({ ok: true, spec: { prompt: "a lighthouse", model: IMAGE_MODEL, width: 768, height: 512, steps: 8 } });
  });

  it("maps sizes and seeds, and rejects junk", () => {
    expect(validateImageRequest({ prompt: "x", size: "portrait" }).spec).toMatchObject({ width: 512, height: 768 });
    expect(validateImageRequest({ prompt: "x", seed: 42 }).spec.seed).toBe(42);
    expect(validateImageRequest({ prompt: "" }).ok).toBe(false);
    expect(validateImageRequest({ prompt: "x".repeat(2001) }).ok).toBe(false);
    expect(validateImageRequest({ prompt: "x", size: "huge" }).ok).toBe(false);
    expect(validateImageRequest({ prompt: "x", seed: -1 }).ok).toBe(false);
    expect(validateImageRequest(null).ok).toBe(false);
  });

  it("prices an image flat, overridable by env", () => {
    expect(imagePriceMicro({})).toBe(DEFAULT_IMAGE_PRICE_MICRO);
    expect(imagePriceMicro({ INFERNET_IMAGE_PRICE_MICRO: "500" })).toBe(500);
    expect(imagePriceMicro({ INFERNET_IMAGE_PRICE_MICRO: "-3" })).toBe(DEFAULT_IMAGE_PRICE_MICRO);
  });
});

import { startImageJob, getImageJob, takeImageJob } from "@/lib/chat/image-jobs";

describe("chat image job registry", () => {
  it("reports pending, then hands the PNG out exactly once", async () => {
    let finish;
    const id = startImageJob(() => new Promise((r) => { finish = r; }));
    expect(getImageJob(id).status).toBe("pending");
    await new Promise((r) => setTimeout(r, 0));
    finish({ png: new Uint8Array([1, 2, 3]), headers: { "x-image-model": "z-image-turbo" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(getImageJob(id).status).toBe("done");
    expect(takeImageJob(id).png).toEqual(new Uint8Array([1, 2, 3]));
    expect(getImageJob(id)).toBeNull();
  });

  it("keeps the error and its status", async () => {
    const id = startImageJob(async () => { throw Object.assign(new Error("No worker"), { status: 503 }); });
    await new Promise((r) => setTimeout(r, 0));
    expect(getImageJob(id)).toMatchObject({ status: "failed", error: "No worker", httpStatus: 503 });
  });

  it("forgets jobs after the TTL", () => {
    const id = startImageJob(() => new Promise(() => {}), { now: 0 });
    expect(getImageJob(id, { now: 16 * 60 * 1000 })).toBeNull();
  });
});
