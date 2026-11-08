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
