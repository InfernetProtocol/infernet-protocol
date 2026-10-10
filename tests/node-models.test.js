import { describe, expect, it, vi } from "vitest";
import { fetchNodeModels, formatNodeModels } from "../apps/cli/lib/node-models.js";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ supabaseUrl: "https://example.supabase.co", supabaseServiceRoleKey: "k", supabaseSchema: "public", pageSize: 25 })
}));

const calls = [];
let rows = {};
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    from: (table) => {
      const filters = [];
      const q = {
        select() { return q; },
        eq(column, value) { filters.push([column, value]); return q; },
        maybeSingle() {
          calls.push({ table, filters: [...filters] });
          const [column, value] = filters[0];
          const row = Object.values(rows).find((r) => r[column] === value && r.is_public);
          return Promise.resolve({ data: row ?? null, error: null });
        }
      };
      return q;
    }
  })
}));

const { getPublicNodeModels } = await import("@/lib/data/infernet");

const UUID = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";

describe("getPublicNodeModels", () => {
  it("finds a node by row id and returns only string model names", async () => {
    rows = { a: { id: UUID, node_id: "node-a", name: "A", status: "available", last_seen: "t", is_public: true, specs: { served_models: ["qwen2.5:7b", "", null, "hf:org/repo"] } } };
    calls.length = 0;
    const node = await getPublicNodeModels(UUID);
    expect(node).toMatchObject({ id: UUID, node_id: "node-a", served_models: ["qwen2.5:7b", "hf:org/repo"] });
    expect(calls[0].filters).toContainEqual(["is_public", true]);
  });

  it("falls back to node_id and never compares a non-uuid against the id column", async () => {
    rows = { a: { id: UUID, node_id: "node-a", is_public: true, specs: {} } };
    calls.length = 0;
    const node = await getPublicNodeModels("node-a");
    expect(node.served_models).toEqual([]);
    expect(calls.map((c) => c.filters[0][0])).toEqual(["node_id"]);
  });

  it("hides private nodes and blank ids", async () => {
    rows = { a: { id: UUID, node_id: "node-a", is_public: false, specs: { served_models: ["x"] } } };
    expect(await getPublicNodeModels(UUID)).toBeNull();
    expect(await getPublicNodeModels("  ")).toBeNull();
  });
});

describe("fetchNodeModels (CLI)", () => {
  const res = (status, body) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });

  it("GETs /api/nodes/:id/models and unwraps data", async () => {
    const fetchImpl = vi.fn(async () => res(200, { data: { id: "1", served_models: ["m1"] } }));
    const node = await fetchNodeModels({ baseUrl: "https://cp.test", nodeId: "a/b", fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://cp.test/api/nodes/a%2Fb/models");
    expect(node.served_models).toEqual(["m1"]);
  });

  it("turns a 404 into a readable error", async () => {
    const fetchImpl = async () => res(404, { error: "node not found" });
    await expect(fetchNodeModels({ baseUrl: "https://cp.test", nodeId: "x", fetchImpl })).rejects.toThrow(/not found \(or not public\)/);
  });

  it("formats models, and says so when there are none", () => {
    expect(formatNodeModels({ name: "A", status: "available", served_models: ["m1", "m2"] })).toContain("MODEL\nm1\nm2\n");
    expect(formatNodeModels({ id: "1", served_models: [] })).toContain("advertises no models");
  });
});
