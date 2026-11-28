import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = [];
vi.mock("@/lib/chat/speech-service", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    fetchSpeechGateway: vi.fn(async (path, init) => {
      calls.push({ path, method: init?.method });
      return new Response(JSON.stringify({ cancelled: true }), { status: path.endsWith("-keyframe") ? 404 : 200 });
    })
  };
});

const { startImageJob, getImageJob } = await import("@/lib/chat/image-jobs");
const { DELETE, GET } = await import("@/app/api/chat/video/[id]/route.js");

const params = (id) => ({ params: Promise.resolve({ id }) });

describe("DELETE /api/chat/video/<id>", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("cancels the gateway request (and its keyframe) and stops the job", async () => {
    let settle;
    const id = startImageJob(() => new Promise((resolve) => (settle = resolve)));
    const res = await DELETE(new Request("http://x"), params(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, status: "cancelled", gateway: "cancelled" });
    expect(calls).toEqual([
      { path: `/v1/result/${id}`, method: "DELETE" },
      { path: `/v1/result/${id}-keyframe`, method: "DELETE" }
    ]);
    expect((await GET(new Request("http://x"), params(id))).status).toBe(410);
    // A result that lands after the cancel is dropped.
    settle({ png: new Uint8Array([1]), headers: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(getImageJob(id).status).toBe("cancelled");
    // Idempotent.
    expect((await DELETE(new Request("http://x"), params(id))).status).toBe(200);
  });

  it("404 for an unknown or malformed id, 409 once finished", async () => {
    expect((await DELETE(new Request("http://x"), params("nope"))).status).toBe(404);
    expect((await DELETE(new Request("http://x"), params("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
    const id = startImageJob(async () => ({ png: new Uint8Array([1]), headers: {} }));
    await new Promise((r) => setTimeout(r, 0));
    expect((await DELETE(new Request("http://x"), params(id))).status).toBe(409);
    expect(calls).toEqual([]);
  });
});
