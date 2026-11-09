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

import { startImageJob, getImageJob, takeImageJob, IMAGE_JOB_TTL_MS } from "@/lib/chat/image-jobs";

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

  it("keeps a job through a long queue wait, then forgets it after the TTL", () => {
    const id = startImageJob(() => new Promise(() => {}), { now: 0 });
    // Queued 90 min for a worker: still there (the old 15 min TTL lost it).
    expect(getImageJob(id, { now: 90 * 60 * 1000 })).not.toBeNull();
    expect(getImageJob(id, { now: IMAGE_JOB_TTL_MS + 1 })).toBeNull();
  });

  it("hands the job (id, meta) to the runner", async () => {
    let seen;
    const id = startImageJob(async (job) => { seen = job; job.meta = { stage: "queued" }; return { png: new Uint8Array([1]) }; });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.id).toBe(id);
    expect(getImageJob(id).meta).toEqual({ stage: "queued" });
  });
});

import { createServer } from "node:http";
import { postSpeechGatewayLong } from "@/lib/chat/speech-service";

describe("postSpeechGatewayLong", () => {
  it("POSTs JSON with the bearer token and returns status, headers and body", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "image/png", "x-c0mpute-job-id": "j1", "x-auth": req.headers.authorization });
        res.end(Buffer.from(`ok:${body}`));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    const prev = { url: process.env.C0MPUTE_SPEECH_URL, token: process.env.C0MPUTE_SPEECH_TOKEN };
    process.env.C0MPUTE_SPEECH_URL = `http://127.0.0.1:${port}/`;
    process.env.C0MPUTE_SPEECH_TOKEN = "tok";
    try {
      const r = await postSpeechGatewayLong("/v1/images", { prompt: "x" });
      expect(r.status).toBe(200);
      expect(r.headers["x-c0mpute-job-id"]).toBe("j1");
      expect(r.headers["x-auth"]).toBe("Bearer tok");
      expect(r.body.toString()).toBe('ok:{"prompt":"x"}');
    } finally {
      process.env.C0MPUTE_SPEECH_URL = prev.url;
      process.env.C0MPUTE_SPEECH_TOKEN = prev.token;
      server.close();
    }
  });
});

import { runGatewayJob } from "@/lib/chat/speech-service";

/** A fake c0mpute gateway: `posts` POSTs answered by `onPost`, results by `onResult`. */
async function fakeGateway(onPost, onResult) {
  const seen = { posts: 0, polls: 0, headers: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST") {
        seen.posts++;
        seen.headers.push(req.headers);
        return onPost(req, res, seen);
      }
      if (req.url.startsWith("/v1/result/")) {
        seen.polls++;
        return onResult(req, res, seen);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const prev = { url: process.env.C0MPUTE_SPEECH_URL, token: process.env.C0MPUTE_SPEECH_TOKEN };
  process.env.C0MPUTE_SPEECH_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.C0MPUTE_SPEECH_TOKEN = "tok";
  return {
    seen,
    close() {
      process.env.C0MPUTE_SPEECH_URL = prev.url;
      process.env.C0MPUTE_SPEECH_TOKEN = prev.token;
      server.close();
    }
  };
}

describe("runGatewayJob (queued gateway jobs)", () => {
  it("waits out a queued job (202) and returns the result, posting it once", async () => {
    const gw = await fakeGateway(
      (req, res) => res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ stage: "queued" })),
      (req, res, seen) => {
        if (seen.polls < 3) return res.writeHead(202).end("{}");
        res.writeHead(200, { "content-type": "image/png" }).end("PNG");
      }
    );
    try {
      const r = await runGatewayJob("/v1/images", { prompt: "x" }, { requestId: "req-1", pollMs: 20 });
      expect(r.status).toBe(200);
      expect(r.body.toString()).toBe("PNG");
      expect(gw.seen.posts).toBe(1);
      expect(gw.seen.headers[0]["x-request-id"]).toBe("req-1");
      expect(gw.seen.headers[0].prefer).toBe("wait=60");
    } finally {
      gw.close();
    }
  });

  it("returns the gateway's final 503 (queue wait expired) without retrying", async () => {
    const gw = await fakeGateway(
      (req, res) => res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "no worker for diffusion.txt2img/z-image-turbo within 2h" })),
      (req, res) => res.writeHead(404).end()
    );
    try {
      const r = await runGatewayJob("/v1/images", { prompt: "x" }, { requestId: "req-2", pollMs: 20 });
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body.toString()).error).toMatch(/within 2h/);
      expect(gw.seen.posts).toBe(1);
    } finally {
      gw.close();
    }
  });

  it("posts again only when the gateway lost the job (404)", async () => {
    const gw = await fakeGateway(
      (req, res, seen) => (seen.posts === 1 ? res.writeHead(202).end("{}") : res.writeHead(200).end("OK")),
      (req, res) => res.writeHead(404).end()
    );
    try {
      const r = await runGatewayJob("/v1/images", { prompt: "x" }, { requestId: "req-3", pollMs: 20 });
      expect(r.status).toBe(200);
      expect(gw.seen.posts).toBe(2);
    } finally {
      gw.close();
    }
  });
});
