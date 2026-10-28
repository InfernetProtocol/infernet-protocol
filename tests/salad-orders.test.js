import { describe, expect, it } from "vitest";
import {
    SALAD_PRICES, SALAD_TIERS, saladModelError, modelsFitting, matchGpuClassId,
    containerGroupSpec, groupName, lifecycleAction, saladConfig, WARMUP_MS
} from "../apps/web/lib/reservations/salad.js";
import { validateOrderInput, quoteFor, capacity, reservationFromOrder } from "../apps/web/lib/reservations/orders.js";
import { validateReservationInput } from "../apps/web/lib/reservations/core.js";
import { tierOf, priceList, GPU_TIERS } from "../apps/web/lib/reservations/pricing.js";

const NOW = Date.parse("2026-10-28T09:20:00.000Z");
const NEXT = "2026-10-28T10:00:00.000Z";

describe("Salad price table (effective 2026-11-01)", () => {
    it("carries Salad's High price as our cost", () => {
        expect(SALAD_PRICES.rtx5090).toMatchObject({ high: 0.6, medium: 0.483, low: 0.367, vram_gb: 32 });
        expect(SALAD_TIERS.rtx4090.cost_per_hour).toBe(0.44);
        expect(SALAD_TIERS.rtx4060ti.cost_per_hour).toBe(0.14);
        expect(Object.keys(SALAD_TIERS)).toHaveLength(15);
    });

    it("lists every Salad card at twice our cost", () => {
        for (const t of Object.values(SALAD_TIERS)) {
            expect(t.price_per_hour).toBeGreaterThanOrEqual(t.cost_per_hour * 2 - 1e-9);
            expect(t.price_per_hour).toBeLessThan(t.cost_per_hour * 2 + 0.01);
        }
    });

    it("joins the order tiers without touching the datacenter ones", () => {
        expect(tierOf("RTX4090")).toBe(SALAD_TIERS.rtx4090);
        expect(tierOf("l40s")).toBe(GPU_TIERS.l40s);
        expect(tierOf("toString")).toBeNull();
        expect(priceList().tiers.map((t) => t.gpu_class)).toEqual(expect.arrayContaining(["h100", "rtx5090"]));
    });
});

describe("order quotes at the default 100% margin", () => {
    it("charges the renter twice Salad's price per hour", () => {
        expect(quoteFor("rtx4090", 1).price_per_hour).toBe(0.88);
        expect(quoteFor("rtx5090", 1).price_per_hour).toBe(1.2);
        expect(quoteFor("rtx3090", 1).price_per_hour).toBe(0.4);
        expect(quoteFor("rtx3080ti", 1).price_per_hour).toBe(0.39);
    });

    it("adds the $5 + one hour setup fee once", () => {
        expect(quoteFor("rtx4090", 10)).toMatchObject({ price_per_hour: 0.88, setup_fee: 5.88, total_usd: 14.68 });
    });

    it("rounds up so the margin never dips under 100%", () => {
        // 0.195 * 2 = 0.39 exactly; 0.155 * 2 = 0.31; a 50% margin on 0.155 is 0.2325 -> 0.24
        expect(quoteFor("rtx3080", 1).price_per_hour).toBe(0.31);
        expect(quoteFor("rtx3080", 1, 50).price_per_hour).toBe(0.24);
        for (const id of Object.keys(SALAD_TIERS)) {
            expect(quoteFor(id, 1).price_per_hour / SALAD_TIERS[id].cost_per_hour).toBeGreaterThanOrEqual(2 - 1e-9);
        }
    });
});

describe("Salad models", () => {
    it("offers only models that fit the card", () => {
        expect(modelsFitting(10)).toEqual(["Qwen/Qwen2.5-1.5B-Instruct", "Qwen/Qwen2.5-3B-Instruct", "Qwen/Qwen2.5-7B-Instruct-AWQ"]);
        expect(modelsFitting(24)).toContain("Qwen/Qwen2.5-32B-Instruct-AWQ");
        expect(modelsFitting(16)).not.toContain("Qwen/Qwen2.5-32B-Instruct-AWQ");
        expect(SALAD_TIERS.rtx4090.fits).toBe("up to 32B models, one per order");
    });

    it("validates one fitting model per Salad order", () => {
        expect(saladModelError("rtx4090", ["Qwen/Qwen2.5-32B-Instruct-AWQ"])).toBeNull();
        expect(saladModelError("rtx4080", ["Qwen/Qwen2.5-32B-Instruct-AWQ"])).toMatch(/not offered on RTX 4080/);
        expect(saladModelError("rtx4090", ["Qwen/Qwen2.5-3B-Instruct", "Qwen/Qwen2.5-7B-Instruct"])).toMatch(/exactly one/);
        expect(saladModelError("l40s", ["a", "b"])).toBeNull();
    });

    it("runs through validateOrderInput", () => {
        expect(validateOrderInput({ gpu_class: "rtx4090", models: ["Qwen/Qwen2.5-7B-Instruct"] }, NOW))
            .toMatchObject({ ok: true, value: { gpu_class: "rtx4090", start_at: NEXT, hours: 1 } });
        const bad = validateOrderInput({ gpu_class: "rtx3080", models: ["Qwen/Qwen2.5-7B-Instruct"] }, NOW);
        expect(bad.ok).toBe(false);
        expect(bad.errors.join()).toMatch(/not offered on RTX 3080/);
        expect(validateOrderInput({ gpu_class: "rtx9999", models: ["m"] }, NOW).errors[0]).toMatch(/rtx5090/);
    });
});

describe("capacity with Salad classes", () => {
    it("lists them on demand, on sale only when Salad is configured", () => {
        const off = capacity([], [], NOW).find((c) => c.gpu_class === "rtx4090");
        expect(off).toMatchObject({ source: "salad", available: false, nodes_available: null, price_per_hour: 0.88, models_per_order: 1 });
        const on = capacity([], [], NOW, 100, { salad: true }).find((c) => c.gpu_class === "rtx5090");
        expect(on).toMatchObject({ available: true, price_per_hour: 1.2 });
        expect(capacity([], [], NOW).find((c) => c.gpu_class === "h100")).toMatchObject({ source: "network", available: false, nodes_available: 0 });
    });
});

describe("Salad reservations", () => {
    it("target the container group's endpoint instead of a node", () => {
        const r = reservationFromOrder({
            id: "o1", name: "t", email: null, operator_name: "Infernet on SaladCloud", provider_id: null,
            models: ["Qwen/Qwen2.5-7B-Instruct"], start_at: NEXT, hours: 3, price_per_hour: 0.88, setup_fee: 5.88,
            gpu_class: "rtx4090", total_usd: 8.52, rail: "checkout"
        }, { url: "https://abc-123.salad.cloud/v1", apiKey: "k" });
        const v = validateReservationInput(r);
        expect(v.ok).toBe(true);
        expect(v.value).toMatchObject({ target_kind: "endpoint", provider_id: null, endpoint_url: "https://abc-123.salad.cloud/v1", endpoint_api_key: "k", gpu_class: "rtx4090", price_per_hour: 0.88 });
    });
});

describe("Salad API helpers", () => {
    it("needs all three settings", () => {
        expect(saladConfig({ SALAD_API_KEY: "k", SALAD_ORG: "o" })).toBeNull();
        expect(saladConfig({ SALAD_API_KEY: "k", SALAD_ORG: "o", SALAD_PROJECT: "p" })).toMatchObject({ org: "o", project: "p", image: expect.stringMatching(/^vllm\/vllm-openai:/) });
    });

    it("matches Salad's GPU class names to our cards", () => {
        const classes = [
            { id: "a", name: "RTX 4090 (24 GB)" }, { id: "b", name: "RTX 4070 Ti Super (16 GB)" },
            { id: "c", name: "RTX 4070 Ti (12 GB)" }, { id: "d", name: "RTX 5090 Laptop (24 GB)" }
        ];
        expect(matchGpuClassId(classes, "rtx4090")).toBe("a");
        expect(matchGpuClassId(classes, "rtx4070ti")).toBe("c");
        expect(matchGpuClassId(classes, "rtx4070tisuper")).toBe("b");
        expect(matchGpuClassId(classes, "rtx5090")).toBeNull();
    });

    it("builds a stopped, high-priority vLLM group with the key only we hold", () => {
        const spec = containerGroupSpec({ orderId: "1F0E-9a", gpuClassId: "g", model: "Qwen/Qwen2.5-7B-Instruct", apiKey: "sek", image: "img" });
        expect(spec).toMatchObject({ name: "infernet-1f0e9a", autostart_policy: false, replicas: 1, networking: { auth: false, port: 8000 } });
        expect(spec.container).toMatchObject({ image: "img", priority: "high", resources: { gpu_classes: ["g"] } });
        expect(spec.container.command).toEqual(expect.arrayContaining(["--model", "Qwen/Qwen2.5-7B-Instruct", "--api-key", "sek", "--host", "::"]));
        expect(groupName("a".repeat(36))).toMatch(/^[a-z][a-z0-9-]{1,62}$/);
    });

    it("stays inside SaladCloud's API limits (a 400 here would fail every paid order)", () => {
        const spec = containerGroupSpec({ orderId: "x", gpuClassId: "g", model: "m", apiKey: "k", image: "i" });
        for (const probe of [spec.startup_probe, spec.readiness_probe]) {
            expect(probe.failure_threshold).toBeGreaterThanOrEqual(1);
            expect(probe.failure_threshold).toBeLessThanOrEqual(20);
            expect(probe.success_threshold).toBeLessThanOrEqual(10);
            expect(probe.period_seconds).toBeLessThanOrEqual(120);
            expect(probe.initial_delay_seconds).toBeLessThanOrEqual(1200);
        }
        const s = spec.startup_probe;
        expect((s.initial_delay_seconds + s.period_seconds * s.failure_threshold) * 1000).toBeLessThan(WARMUP_MS);
        expect(spec.container.resources.memory).toBeGreaterThanOrEqual(1024);
        expect(spec.display_name.length).toBeLessThanOrEqual(63);
        expect(spec.networking.client_request_timeout).toBeLessThanOrEqual(100000);
    });
});

describe("lifecycleAction", () => {
    const start = Date.parse(NEXT);
    const order = { salad_group: "infernet-x", start_at: NEXT, hours: 2, salad_state: "created" };

    it("starts an hour before the window, deletes at the end", () => {
        expect(lifecycleAction(order, start - WARMUP_MS - 1)).toBeNull();
        expect(lifecycleAction(order, start - WARMUP_MS)).toBe("start");
        expect(lifecycleAction({ ...order, salad_state: "started" }, start + 1000)).toBeNull();
        expect(lifecycleAction({ ...order, salad_state: "started" }, start + 2 * 3600_000)).toBe("delete");
        expect(lifecycleAction(order, start + 3 * 3600_000)).toBe("delete");
        expect(lifecycleAction({ ...order, salad_state: "deleted" }, start + 3 * 3600_000)).toBeNull();
        expect(lifecycleAction({ ...order, salad_group: null }, start)).toBeNull();
    });
});
