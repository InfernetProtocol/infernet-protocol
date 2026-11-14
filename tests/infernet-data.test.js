import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role",
    supabaseSchema: "public",
    pageSize: 25
  })
}));

const queryState = {};

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    from: (table) => {
      queryState.table = table;
      return {
        select() {
          return this;
        },
        order() {
          return this;
        },
        eq(column, value) {
          queryState.eq = [column, value];
          return this;
        },
        limit(value) {
          queryState.limit = value;
          return Promise.resolve({
            data: [
              {
                id: "1",
                name: "Node One",
                role: "provider",
                status: "available",
                location: "Portland",
                price: 1.25,
                title: "Job One",
                payment_offer: 10,
                family: "llama",
                context_length: 4096,
                visibility: "public",
                gpu_model: "A100"
              }
            ],
            error: null
          });
        }
      };
    }
  })
}));

const { __testables__, getJobs, getNodes, getProviders } = await import("@/lib/data/infernet");

describe("infernet data mapping", () => {
  it("formats provider pricing + summarizes hardware columns", () => {
    expect(
      __testables__.mapProvider({
        id: "p1",
        name: "Provider One",
        status: "available",
        gpu_model: "A100",
        price: 1.5,
        reputation: 88,
        specs: {
          cpu: { vendor: "amd", arch: "x64", cores: 16, ram_gb: 64 },
          gpus: [{ vendor: "nvidia", model: "A100", vram_tier: ">=48gb" }],
          interconnects: { nvlink: { available: true }, rdma_capable: false }
        }
      })
    ).toEqual({
      id: "p1",
      name: "Provider One",
      status: "available",
      gpu_summary: "A100",
      cpu_summary: "amd · x64 · 16 cores",
      fabric: "NVLink",
      price_display: "$1.5000",
      reputation: 88,
      cli_version: "—"
    });
  });

  it("applies safe limits and node filters", async () => {
    await getNodes({ limit: 500, status: "available" });
    expect(queryState.table).toBe("nodes");
    expect(queryState.eq).toEqual(["status", "available"]);
    expect(queryState.limit).toBe(100);
  });

  it("maps job and provider queries", async () => {
    expect(await getJobs({ limit: 1 })).toEqual([
      expect.objectContaining({
        // Type and short id, never the title (it can carry caller content).
        title: "job · 1",
        payment_offer: "$10.0000",
        // An offer-priced job shows its offer as what it was charged.
        charged: "$10.0000"
      })
    ]);

    expect(await getProviders({ limit: 1 })).toEqual([
      expect.objectContaining({
        name: "Node One",
        price_display: "$1.2500"
      })
    ]);
  });
});
