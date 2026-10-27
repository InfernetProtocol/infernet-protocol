import { describe, expect, it } from "vitest";
import {
    validateOrderInput, quoteFor, classesOf, pickNode, capacity, reservationFromOrder, nextWholeHour, isOnline
} from "../apps/web/lib/reservations/orders.js";
import { validateReservationInput } from "../apps/web/lib/reservations/core.js";
import { createOrdersClient, orderBodyFromFlags } from "../apps/cli/lib/orders-client.js";
import { handleMessage } from "../apps/cli/commands/mcp.js";

const NOW = Date.parse("2026-10-27T05:20:00.000Z");
const NEXT = "2026-10-27T06:00:00.000Z";

function node(id, gpus, models, extra = {}) {
    return {
        id, name: `node-${id}`, status: "available", last_seen: new Date(NOW - 30_000).toISOString(), reputation: 50,
        specs: { gpus: gpus.map((m) => (typeof m === "string" ? { model: m, vram_tier: ">=48gb" } : m)), served_models: models },
        ...extra
    };
}

describe("validateOrderInput", () => {
    it("defaults to one hour from the next whole hour", () => {
        const v = validateOrderInput({ gpu_class: "L40S", models: "qwen3:8b, qwen3:8b" }, NOW);
        expect(v.ok).toBe(true);
        expect(v.value).toMatchObject({ gpu_class: "l40s", models: ["qwen3:8b"], hours: 1, start_at: NEXT });
    });

    it("refuses past, partial-hour, too-far and oversize orders", () => {
        expect(validateOrderInput({ gpu_class: "l40s", models: ["m"], start_at: "2026-10-27T05:00:00Z" }, NOW).ok).toBe(false);
        expect(validateOrderInput({ gpu_class: "l40s", models: ["m"], start_at: "2026-10-27T06:30:00Z" }, NOW).ok).toBe(false);
        expect(validateOrderInput({ gpu_class: "l40s", models: ["m"], start_at: "2026-12-27T06:00:00Z" }, NOW).ok).toBe(false);
        expect(validateOrderInput({ gpu_class: "l40s", models: ["m"], hours: 169 }, NOW).ok).toBe(false);
        expect(validateOrderInput({ gpu_class: "rtx4090", models: ["m"] }, NOW).ok).toBe(false);
        expect(validateOrderInput({ gpu_class: "l40s" }, NOW).ok).toBe(false);
    });
});

describe("quoteFor", () => {
    it("is hours at the list price plus the setup fee", () => {
        expect(quoteFor("l40s", 3)).toMatchObject({ price_per_hour: 1.35, setup_fee: 6.35, total_usd: 10.4 });
        expect(quoteFor("h100x2", 1).total_usd).toBe(20.98);
    });
});

describe("classesOf", () => {
    it("reads the class from the reported GPUs", () => {
        expect(classesOf(node("a", ["NVIDIA L40S"], []))).toEqual(["l40s"]);
        expect(classesOf(node("b", ["NVIDIA H100 80GB HBM3", "NVIDIA H100 80GB HBM3"], []))).toEqual(["h100", "h100x2"]);
        expect(classesOf(node("c", ["NVIDIA GeForce RTX 4090"], []))).toEqual([]);
    });

    it("never sells a 40GB A100 as the 80GB class", () => {
        expect(classesOf(node("d", [{ model: "NVIDIA A100-SXM4-40GB", vram_tier: "24-48gb" }], []))).toEqual([]);
        expect(classesOf(node("e", [{ model: "NVIDIA A100 80GB PCIe", vram_tier: ">=48gb" }], []))).toEqual(["a100"]);
    });
});

describe("pickNode", () => {
    const order = { gpu_class: "l40s", models: ["qwen3:8b"], start_at: NEXT, hours: 2, provider_id: null };

    it("needs the class, every model, online, public and free", () => {
        const fits = node("ok", ["NVIDIA L40S"], ["qwen3:8b", "llama3:8b"]);
        const rows = [
            node("nomodel", ["NVIDIA L40S"], ["llama3:8b"]),
            node("stale", ["NVIDIA L40S"], ["qwen3:8b"], { last_seen: new Date(NOW - 10 * 60_000).toISOString() }),
            node("private", ["NVIDIA L40S"], ["qwen3:8b"], { trust_tier: "private" }),
            node("busy", ["NVIDIA L40S"], ["qwen3:8b"], { reputation: 99 }),
            fits
        ];
        const booked = [{ provider_id: "busy", start_at: "2026-10-27T07:00:00.000Z", hours: 1 }];
        expect(pickNode(rows, order, booked, NOW)?.id).toBe("ok");
        expect(pickNode(rows, { ...order, models: ["qwen3:8b", "llama3:8b"] }, booked, NOW)?.id).toBe("ok");
        expect(pickNode(rows, { ...order, gpu_class: "h100" }, booked, NOW)).toBeNull();
    });

    it("a booking that ended before the order starts does not block", () => {
        const rows = [node("n", ["NVIDIA L40S"], ["qwen3:8b"])];
        expect(pickNode(rows, order, [{ provider_id: "n", start_at: "2026-10-27T04:00:00.000Z", hours: 2 }], NOW)?.id).toBe("n");
        expect(pickNode(rows, order, [{ provider_id: "n", start_at: "2026-10-27T04:00:00.000Z", hours: 3 }], NOW)).toBeNull();
    });

    it("honours a requested node", () => {
        const rows = [node("x", ["NVIDIA L40S"], ["qwen3:8b"], { reputation: 90 }), node("y", ["NVIDIA L40S"], ["qwen3:8b"])];
        expect(pickNode(rows, order, [], NOW)?.id).toBe("x");
        expect(pickNode(rows, { ...order, provider_id: "y" }, [], NOW)?.id).toBe("y");
    });
});

describe("capacity", () => {
    it("counts free nodes and lists their models per class", () => {
        const rows = [node("a", ["NVIDIA L40S"], ["m2", "m1"]), node("b", ["NVIDIA GeForce GTX 745"], ["m3"])];
        const c = capacity(rows, [], NOW);
        expect(c.find((k) => k.gpu_class === "l40s")).toMatchObject({ nodes_available: 1, models: ["m1", "m2"], price_per_hour: 1.35 });
        expect(c.find((k) => k.gpu_class === "h100").nodes_available).toBe(0);
    });
});

describe("reservationFromOrder", () => {
    it("is a valid priced reservation on the matched node", () => {
        const r = reservationFromOrder({
            id: "o1", name: "test", email: "a@b.co", operator_name: "node-a", provider_id: "11111111-1111-1111-1111-111111111111",
            models: ["m1"], start_at: NEXT, hours: 2, price_per_hour: 1.35, setup_fee: 6.35, gpu_class: "l40s", total_usd: 9.05, rail: "x402"
        });
        const v = validateReservationInput(r);
        expect(v.ok).toBe(true);
        expect(v.value).toMatchObject({ target_kind: "node", price_per_hour: 1.35, setup_fee: 6.35, gpu_class: "l40s", hours: 2 });
    });
});

describe("helpers", () => {
    it("nextWholeHour and isOnline", () => {
        expect(nextWholeHour(NOW).toISOString()).toBe(NEXT);
        expect(isOnline({ status: "offline", last_seen: new Date(NOW).toISOString() }, NOW)).toBe(false);
    });
});

describe("CLI orders client", () => {
    it("checkout posts pay: checkout", async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body) });
            return new Response(JSON.stringify({ data: { checkout_url: "https://coinpayportal.com/c/x", buyer_token: "ifr_buy_x" } }), { status: 201 });
        };
        const c = createOrdersClient({ baseUrl: "https://ip.test", fetchImpl });
        const r = await c.checkout({ gpu_class: "l40s", models: ["m"] });
        expect(r.checkout_url).toContain("coinpayportal");
        expect(calls[0]).toMatchObject({ url: "https://ip.test/api/v1/orders", body: { pay: "checkout", gpu_class: "l40s" } });
    });

    it("x402 hands the POST to the payer and returns the reservation", async () => {
        let seen = null;
        const x402 = (opts) => ({
            pay: async (url, { init }) => {
                seen = { url, init, opts };
                return { status: 201, body: { data: { order: { id: "o" }, api_key: "ifr_res_k" } }, amountUsd: 7.7, payer: "0xabc", network: "eip155:8453" };
            }
        });
        const c = createOrdersClient({ baseUrl: "https://ip.test", fetchImpl: fetch, x402 });
        const r = await c.payX402({ gpu_class: "l40s", models: ["m"] }, { key: "0x01", maxUsd: 10 });
        expect(r).toMatchObject({ api_key: "ifr_res_k", paid_usd: 7.7, payer: "0xabc" });
        expect(seen.url).toBe("https://ip.test/api/v1/orders");
        expect(seen.init.method).toBe("POST");
        expect(seen.opts.maxUsd).toBe(10);
        await expect(c.payX402({}, {})).rejects.toThrow(/X402_PRIVATE_KEY/);
    });

    it("flags map to the order body", () => {
        const flags = { gpu: "a100", models: "m1, m2", hours: "3" };
        expect(orderBodyFromFlags((k) => flags[k])).toEqual({ gpu_class: "a100", models: ["m1", "m2"], hours: 3 });
    });

    it("the MCP server lists the order tools", async () => {
        const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});
        const names = r.result.tools.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(["order_capacity", "order_quote", "order_create", "order_status"]));
    });
});
