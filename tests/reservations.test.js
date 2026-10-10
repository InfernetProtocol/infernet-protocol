import { describe, expect, it } from "vitest";
import {
    validateReservationInput, newReservationKey, isReservationKey, bearerFrom, sha256,
    phaseOf, createLimiter, buildReport, buildInvoice, publicReservation, tokenAllowanceLeft
} from "../apps/web/lib/reservations/core.js";
import { judgeNode } from "../apps/web/lib/data/reservation-upstream.js";
import { handleMessage, TOOLS } from "../apps/cli/commands/mcp.js";
import { createReservationsClient, createBodyFromFlags, renderReport, renderInvoice } from "../apps/cli/lib/reservations-client.js";
import { GPU_TIERS, floorPrice, priceList, PAYMENT_FEE, COMPLIANCE_BUFFER } from "../apps/web/lib/reservations/pricing.js";

const START = "2026-10-12T15:00:00.000Z";
const T0 = Date.parse(START);
const MIN = 60_000;
const HOUR = 60 * MIN;

function res(over = {}) {
    return {
        id: "11111111-1111-1111-1111-111111111111",
        name: "kai-pilot", buyer: "KAI", operator_name: "op-1",
        target_kind: "endpoint", endpoint_url: "https://op.example/v1", provider_id: null,
        models: ["qwen2.5:7b"], start_at: START, hours: 2,
        included_tokens: 1000, tokens_used: 0,
        per_key_rps: 2, per_key_concurrency: 1, shared_rps: 3, shared_concurrency: 2,
        required_minutes_per_hour: 60, status: "scheduled",
        currency: "USD", price_per_hour: 10,
        endpoint_secret: { _enc: "x" }, buyer_token_hash: "h",
        ...over
    };
}

const allMinutes = (hourIdx, ok = true) =>
    Array.from({ length: 60 }, (_, m) => ({ minute: new Date(T0 + hourIdx * HOUR + m * MIN).toISOString(), ok, latency_ms: 100 }));

describe("validateReservationInput", () => {
    const good = {
        name: "kai-pilot", operator_name: "op-1", models: ["qwen2.5:7b"],
        endpoint_url: "https://op.example/v1/", start_at: START, hours: 1,
        included_tokens: 2_000_000, per_key_rps: 2, per_key_concurrency: 2, shared_rps: 10, shared_concurrency: 8
    };

    it("accepts a whole-hour endpoint reservation and normalizes the URL", () => {
        const v = validateReservationInput(good);
        expect(v.ok).toBe(true);
        expect(v.value.target_kind).toBe("endpoint");
        expect(v.value.endpoint_url).toBe("https://op.example/v1");
        expect(v.value.price_per_hour).toBeNull();
        expect(v.value.required_minutes_per_hour).toBe(60);
    });

    it("rejects a start that is not on a whole hour", () => {
        const v = validateReservationInput({ ...good, start_at: "2026-10-12T15:30:00Z" });
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/whole UTC hour/);
    });

    it("requires exactly one target", () => {
        expect(validateReservationInput({ ...good, provider_id: "abc" }).ok).toBe(false);
        const none = { ...good };
        delete none.endpoint_url;
        expect(validateReservationInput(none).ok).toBe(false);
        const node = validateReservationInput({ ...none, provider_id: "22222222-2222-2222-2222-222222222222" });
        expect(node.ok).toBe(true);
        expect(node.value.target_kind).toBe("node");
    });

    it("refuses per-key limits above the shared limits", () => {
        const v = validateReservationInput({ ...good, per_key_rps: 20, shared_rps: 10 });
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/per_key_rps cannot exceed shared_rps/);
    });

    it("needs exact models and an identified operator", () => {
        const v = validateReservationInput({ ...good, models: [], operator_name: " " });
        expect(v.ok).toBe(false);
        expect(v.errors.join()).toMatch(/models/);
        expect(v.errors.join()).toMatch(/operator_name/);
    });
});

describe("keys", () => {
    it("issues prefixed keys whose hash is what gets stored", () => {
        const k = newReservationKey();
        expect(isReservationKey(k.key)).toBe(true);
        expect(k.hash).toBe(sha256(k.key));
        expect(k.prefix).toBe(k.key.slice(0, 12));
        expect(newReservationKey().key).not.toBe(k.key);
    });

    it("pulls the bearer out of an Authorization header", () => {
        expect(bearerFrom("Bearer ifr_res_abc")).toBe("ifr_res_abc");
        expect(bearerFrom("bearer  x")).toBe("x");
        expect(bearerFrom(null)).toBeNull();
        expect(isReservationKey("sk-openai")).toBe(false);
    });
});

describe("phaseOf", () => {
    it("tracks the reserved window", () => {
        const r = res();
        expect(phaseOf(r, T0 - 1)).toBe("upcoming");
        expect(phaseOf(r, T0)).toBe("active");
        expect(phaseOf(r, T0 + 2 * HOUR - 1)).toBe("active");
        expect(phaseOf(r, T0 + 2 * HOUR)).toBe("ended");
        expect(phaseOf(res({ status: "cancelled" }), T0)).toBe("cancelled");
    });
});

describe("createLimiter", () => {
    it("enforces per-key rps, then shared rps, with headers saying which", () => {
        let now = T0;
        const lim = createLimiter(() => now);
        const r = res({ per_key_concurrency: 10, shared_concurrency: 10 });
        const a1 = lim.acquire(r, "a"); a1.release();
        const a2 = lim.acquire(r, "a"); a2.release();
        const a3 = lim.acquire(r, "a");
        expect(a3.ok).toBe(false);
        expect(a3.type).toBe("rps");
        expect(a3.scope).toBe("key");
        expect(a3.headers["X-Infernet-Limit-Scope"]).toBe("key");
        expect(a3.headers["Retry-After"]).toBe("1");

        const b1 = lim.acquire(r, "b"); b1.release();
        const b2 = lim.acquire(r, "b");
        expect(b2.ok).toBe(false);
        expect(b2.scope).toBe("shared");
        expect(b2.headers["X-Infernet-Limit-Type"]).toBe("rps");

        now += 1000;
        expect(lim.acquire(r, "b").ok).toBe(true);
    });

    it("enforces concurrency until a slot is released", () => {
        let now = T0;
        const lim = createLimiter(() => now);
        const r = res({ per_key_rps: 100, shared_rps: 100 });
        const a = lim.acquire(r, "a");
        expect(a.ok).toBe(true);
        const a2 = lim.acquire(r, "a");
        expect(a2.ok).toBe(false);
        expect(a2.type).toBe("concurrency");
        expect(a2.scope).toBe("key");
        const b = lim.acquire(r, "b");
        expect(b.ok).toBe(true);
        const c = lim.acquire(r, "c");
        expect(c.ok).toBe(false);
        expect(c.scope).toBe("shared");
        a.release();
        a.release(); // idempotent
        expect(lim.acquire(r, "c").ok).toBe(true);
    });
});

describe("buildReport", () => {
    it("marks an hour compliant only when every minute is confirmed, traffic or not", () => {
        const r = res();
        const probes = [...allMinutes(0), ...allMinutes(1).filter((_, i) => i !== 30)];
        const rep = buildReport(r, probes, [], T0 + 3 * HOUR);
        expect(rep.hours[0].status).toBe("compliant");
        expect(rep.hours[0].usage.requests).toBe(0);
        expect(rep.hours[1].status).toBe("non_compliant");
        expect(rep.hours[1].minutes).toEqual({ confirmed: 59, failed: 0, unconfirmed: 1, required: 60 });
    });

    it("counts a failed probe and a failed real request against the minute", () => {
        const r = res({ hours: 1 });
        const probes = allMinutes(0).map((p, i) => (i === 5 ? { ...p, ok: false, detail: "HTTP 503" } : p));
        const usage = [
            { at: new Date(T0 + 10 * MIN + 5000).toISOString(), outcome: "upstream_error" },
            { at: new Date(T0 + 11 * MIN).toISOString(), outcome: "ok", prompt_tokens: 10, completion_tokens: 20 },
            { at: new Date(T0 + 12 * MIN).toISOString(), outcome: "limit_rps" }
        ];
        const h = buildReport(r, probes, usage, T0 + 2 * HOUR).hours[0];
        expect(h.status).toBe("non_compliant");
        expect(h.minutes.failed).toBe(2);
        expect(h.failures.map((f) => f.reason)).toEqual(["HTTP 503", "request failed upstream"]);
        expect(h.usage.requests).toBe(2);
        expect(h.usage.prompt_tokens + h.usage.completion_tokens).toBe(30);
        expect(h.usage.limit_hits.rps).toBe(1);
    });

    it("honours a lower agreed minute threshold", () => {
        const r = res({ hours: 1, required_minutes_per_hour: 57 });
        const probes = allMinutes(0).slice(0, 57);
        expect(buildReport(r, probes, [], T0 + 2 * HOUR).hours[0].status).toBe("compliant");
    });

    it("never judges an hour that has not finished", () => {
        const rep = buildReport(res(), allMinutes(0).slice(0, 10), [], T0 + 10 * MIN);
        expect(rep.phase).toBe("active");
        expect(rep.hours[0].status).toBe("in_progress");
        expect(rep.hours[0].minutes.confirmed).toBe(10);
        expect(rep.hours[0].minutes.unconfirmed).toBe(0);
        expect(rep.hours[1].status).toBe("upcoming");
    });
});

describe("buildInvoice", () => {
    it("bills only compliant hours", () => {
        const r = res({ hours: 3, price_per_hour: 12.5 });
        const probes = [...allMinutes(0), ...allMinutes(1, false), ...allMinutes(2)];
        const inv = buildInvoice(r, buildReport(r, probes, [], T0 + 4 * HOUR));
        expect(inv.final).toBe(true);
        expect(inv.hours_compliant).toBe(2);
        expect(inv.hours_non_compliant).toBe(1);
        expect(inv.amount_due).toBe(25);
        expect(inv.lines.map((l) => l.amount)).toEqual([12.5, 0, 12.5]);
    });

    it("says unpriced instead of inventing an amount", () => {
        const r = res({ hours: 1, price_per_hour: null });
        const inv = buildInvoice(r, buildReport(r, allMinutes(0), [], T0 + 2 * HOUR));
        expect(inv.priced).toBe(false);
        expect(inv.amount_due).toBeNull();
        expect(inv.lines[0].amount).toBeNull();
        expect(inv.note).toMatch(/No price has been agreed/);
    });

    it("is not final while hours are open, and a cancelled reservation owes nothing", () => {
        const r = res({ hours: 2 });
        expect(buildInvoice(r, buildReport(r, allMinutes(0), [], T0 + 90 * MIN)).final).toBe(false);
        const c = res({ hours: 1, status: "cancelled" });
        expect(buildInvoice(c, buildReport(c, allMinutes(0), [], T0 + 2 * HOUR)).amount_due).toBe(0);
    });
});

describe("publicReservation", () => {
    it("never exposes the endpoint secret or token hash", () => {
        const p = publicReservation(res({ tokens_used: 400 }), T0);
        expect(p.endpoint_secret).toBeUndefined();
        expect(p.buyer_token_hash).toBeUndefined();
        expect(p.has_endpoint_key).toBe(true);
        expect(p.tokens_remaining).toBe(600);
        expect(p.end_at).toBe("2026-10-12T17:00:00.000Z");
        expect(tokenAllowanceLeft(res({ tokens_used: 5000 }))).toBe(0);
    });
});

describe("judgeNode", () => {
    const fresh = { status: "available", last_seen: new Date(T0 - 10_000).toISOString(), specs: { served_models: ["qwen2.5:7b"] } };
    it("needs a fresh heartbeat serving every reserved model", () => {
        expect(judgeNode(fresh, ["qwen2.5:7b"], T0).ok).toBe(true);
        expect(judgeNode({ ...fresh, last_seen: new Date(T0 - 120_000).toISOString() }, ["qwen2.5:7b"], T0).ok).toBe(false);
        expect(judgeNode(fresh, ["llama3:70b"], T0).detail).toMatch(/not served/);
        expect(judgeNode({ ...fresh, status: "offline" }, ["qwen2.5:7b"], T0).ok).toBe(false);
        expect(judgeNode(null, ["x"], T0).ok).toBe(false);
    });
});

describe("CLI client + MCP", () => {
    function fakeFetch(calls) {
        return async (url, init) => {
            calls.push({ url, init });
            return new Response(JSON.stringify({ data: { ok: true, url } }), { status: 200 });
        };
    }

    it("sends the admin bearer, or the buyer token on read paths", async () => {
        const calls = [];
        const admin = createReservationsClient({ baseUrl: "https://x", adminToken: "adm", fetchImpl: fakeFetch(calls) });
        await admin.issueKey("r1", "cust-a");
        expect(calls[0].url).toBe("https://x/api/v1/reservations/r1/keys");
        expect(calls[0].init.headers.authorization).toBe("Bearer adm");
        const buyer = createReservationsClient({ baseUrl: "https://x", buyerToken: "ifr_buy_1", fetchImpl: fakeFetch(calls) });
        await buyer.report("r1", { minutes: true });
        expect(calls[1].url).toBe("https://x/api/v1/reservations/r1/report?minutes=1");
        expect(calls[1].init.headers["x-buyer-token"]).toBe("ifr_buy_1");
        expect(calls[1].init.headers.authorization).toBeUndefined();
        await buyer.issueKey("r1", "cust-b");
        await buyer.revokeKey("r1", "k1");
        expect(calls[2].init.headers["x-buyer-token"]).toBe("ifr_buy_1");
        expect(calls[3].init.method).toBe("DELETE");
        expect(calls[3].init.headers["x-buyer-token"]).toBe("ifr_buy_1");
    });

    it("surfaces server validation details as the error", async () => {
        const c = createReservationsClient({
            baseUrl: "https://x", adminToken: "a",
            fetchImpl: async () => new Response(JSON.stringify({ error: "invalid reservation", details: ["start_at must be a whole UTC hour"] }), { status: 400 })
        });
        await expect(c.create({})).rejects.toThrow(/whole UTC hour/);
    });

    it("maps CLI flags onto the create body", () => {
        const flags = { name: "p", operator: "op", models: "a, b", "endpoint-url": "https://e/v1", start: START, hours: "2", "per-key-rps": "3", "probe-completion": true };
        const body = createBodyFromFlags((k) => flags[k]);
        expect(body).toEqual({ name: "p", operator_name: "op", models: ["a", "b"], endpoint_url: "https://e/v1", start_at: START, hours: 2, per_key_rps: 3, probe_completion: true });
    });

    it("renders report and invoice text", () => {
        const r = res({ hours: 1 });
        const rep = buildReport(r, allMinutes(0), [], T0 + 2 * HOUR);
        expect(renderReport(rep)).toMatch(/compliant\s+60\/60 confirmed/);
        expect(renderInvoice(buildInvoice(r, rep))).toMatch(/amount due: 10\.00 USD/);
    });

    it("speaks MCP: initialize, tools/list, tools/call", async () => {
        const client = { invoice: async (id) => ({ id, amount_due: 0 }) };
        const init = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, client);
        expect(init.result.capabilities.tools).toEqual({});
        const list = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, client);
        expect(list.result.tools.map((t) => t.name)).toContain("reservation_report");
        expect(list.result.tools.every((t) => t.inputSchema && !t.run)).toBe(true);
        const call = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reservation_invoice", arguments: { id: "r1" } } }, client);
        expect(JSON.parse(call.result.content[0].text)).toEqual({ id: "r1", amount_due: 0 });
        const bad = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } }, client);
        expect(bad.error.code).toBe(-32602);
        expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, client)).toBeNull();
        expect(TOOLS.length).toBeGreaterThan(5);
    });
});

describe("pricing", () => {
    const base = {
        name: "kai-pilot", operator_name: "op-1", models: ["qwen2.5:7b"],
        endpoint_url: "https://op.example/v1", start_at: START, hours: 1
    };

    it("every list price clears the 20% margin after fees and the compliance buffer", () => {
        for (const t of Object.values(GPU_TIERS)) {
            expect(t.price_per_hour).toBeGreaterThanOrEqual(floorPrice(t.cost_per_hour));
            const margin = (t.price_per_hour * (1 - PAYMENT_FEE) / (1 + COMPLIANCE_BUFFER) - t.cost_per_hour) / t.price_per_hour;
            expect(margin).toBeGreaterThanOrEqual(0.19);
        }
    });

    it("gpu_class prices the reservation and sets the setup fee", () => {
        const v = validateReservationInput({ ...base, gpu_class: "H100" });
        expect(v.ok).toBe(true);
        expect(v.value.gpu_class).toBe("h100");
        expect(v.value.price_per_hour).toBe(3.99);
        expect(v.value.setup_fee).toBe(8.99);
    });

    it("refuses a price under the tier's margin floor and an unknown class", () => {
        expect(validateReservationInput({ ...base, gpu_class: "l40s", price_per_hour: 1 }).ok).toBe(false);
        expect(validateReservationInput({ ...base, gpu_class: "l40s", price_per_hour: 2 }).ok).toBe(true);
        expect(validateReservationInput({ ...base, gpu_class: "tpu" }).ok).toBe(false);
    });

    it("bills the setup fee once, only after a compliant hour", () => {
        const r = res({ hours: 2, price_per_hour: 1.35, setup_fee: 6.35, gpu_class: "l40s" });
        const paid = buildInvoice(r, buildReport(r, [...allMinutes(0), ...allMinutes(1)], [], T0 + 3 * HOUR));
        expect(paid.amount_due).toBe(9.05);
        const failed = buildInvoice(r, buildReport(r, [], [], T0 + 3 * HOUR));
        expect(failed.amount_due).toBe(0);
        expect(failed.setup_fee).toBe(0);
    });

    it("publishes the list with setup fees", () => {
        const l = priceList();
        expect(l.tiers.map((t) => t.gpu_class)).toEqual(["l40s", "a100", "h100", "h100x2"]);
        expect(l.tiers[0].setup_fee).toBe(6.35);
    });
});
