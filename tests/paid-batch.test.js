import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "./fixtures/fake-supabase.js";
import {
    usdToMicro, microToUsd, numericUsdToMicro, estimateInputTokens, estimateOutputTokens, costMicro, itemMaxCostMicro,
    itemChargeMicro, providerSplitMicro, validateBatch, resolveInferencePricing, validatePricingPatch, quoteView,
    parseTopupAmount, ledger, planFunding, parseFunding, fundingBreakdown, shortfallCents, buildReceipt,
    DEFAULT_INFERENCE_PRICING, QUOTE_TTL_MS
} from "../apps/web/lib/billing/core.js";
import { computeJobCredits, summariseBalance, DEFAULT_EARNINGS_CONFIG } from "../apps/web/lib/earnings/core.js";
import { summariseRevenue } from "../apps/web/lib/earnings/revenue.js";
import { readBatchJsonl, createBatchClient } from "../apps/cli/lib/batch-client.js";
import { TOOLS } from "../apps/cli/commands/mcp.js";

// ---- shared fakes for the DB-backed modules ---------------------------------

let fake;
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fake }));
vi.mock("@/lib/encrypt", () => ({ encryptJSON: (v) => v, decryptJSON: (v) => v }));
vi.mock("@infernetprotocol/payments", () => ({
    createCheckout: vi.fn(async ({ orderId }) => ({ id: `cs_${orderId}`, paymentUrl: `https://pay.example/${orderId}` })),
    getPayment: vi.fn()
}));
const chat = { createChatJob: vi.fn(), pickChatProvider: vi.fn() };
vi.mock("@/lib/data/chat", () => ({
    createChatJob: (...a) => chat.createChatJob(...a),
    pickChatProvider: (...a) => chat.pickChatProvider(...a)
}));

const batches = await import("@/lib/data/batches");
const billing = await import("@/lib/data/billing");

const PRICE_7B = { input_micro_per_m: 50_000, output_micro_per_m: 200_000 };
const USER = { id: "user-1", email: "buyer@example.com" };
const msgs = (content) => [{ role: "user", content }];
const item = (id, content = "hello world!", max = 100) => ({ custom_id: id, messages: msgs(content), max_tokens: max });

function liveProvider(models = ["qwen2.5:7b"]) {
    return { id: "prov-1", status: "available", disabled_at: null, last_seen: new Date().toISOString(), specs: { served_models: models } };
}

function freshFake({ pricing = null, providers = [liveProvider()], rpc = {} } = {}) {
    fake = createFakeSupabase({
        tables: {
            settings: pricing ? [{ key: "inference_pricing", value: pricing }] : [],
            providers,
            inference_batches: [],
            inference_batch_items: [],
            inference_batch_quotes: [],
            provider_earnings: [],
            billing_topups: []
        },
        rpc
    });
    return fake;
}

beforeEach(() => {
    chat.createChatJob.mockReset();
    chat.pickChatProvider.mockReset();
    freshFake();
});

// ---- money math ---------------------------------------------------------------

describe("micro-USD parsing and formatting", () => {
    it("parses decimal USD exactly, never through float multiplication", () => {
        expect(usdToMicro("0.05")).toBe(50_000);
        expect(usdToMicro(0.2)).toBe(200_000);
        expect(usdToMicro("2.50")).toBe(2_500_000);
        expect(usdToMicro("0.000001")).toBe(1);
        expect(usdToMicro(0.1 + 0.2)).toBeNull(); // 0.30000000000000004: more precision than a micro-dollar
        expect(usdToMicro("0.0000001")).toBeNull();
        expect(usdToMicro("-1")).toBeNull();
        expect(usdToMicro("1e3")).toBeNull();
        expect(usdToMicro(1e-7)).toBeNull();
    });
    it("formats and reads back Postgres numerics", () => {
        expect(microToUsd(1)).toBe("0.000001");
        expect(microToUsd(2_500_000)).toBe("2.500000");
        expect(microToUsd(-5)).toBe("-0.000005");
        expect(numericUsdToMicro("0.00098000")).toBe(980);
        expect(numericUsdToMicro("-2.00000000")).toBe(-2_000_000);
    });
});

describe("server-side token estimation", () => {
    it("input = ceil(chars/4) over message contents", () => {
        expect(estimateInputTokens(msgs("abcd"))).toBe(1);
        expect(estimateInputTokens(msgs("abcde"))).toBe(2);
        expect(estimateInputTokens([{ role: "user", content: [{ type: "text", text: "abcdefgh" }] }])).toBe(2);
    });
    it("output = ceil(chars/4), capped at max_tokens, and the provider's count is ignored", () => {
        expect(estimateOutputTokens({ text: "x".repeat(9), token_count: 99999 }, 100)).toBe(3);
        expect(estimateOutputTokens({ text: "x".repeat(4000) }, 10)).toBe(10);
        expect(estimateOutputTokens({ token_count: 500 }, 100)).toBe(0);
    });
});

describe("pricing math", () => {
    it("rounds each item up to the micro-dollar, once", () => {
        // 3 input tokens at $0.05/M = 0.15 micro; rounds up to 1.
        expect(costMicro({ inputTokens: 3, outputTokens: 0, ...PRICE_7B })).toBe(1);
        // 1000 in + 1000 out = 50 + 200 = 250 micro exactly.
        expect(costMicro({ inputTokens: 1000, outputTokens: 1000, ...PRICE_7B })).toBe(250);
        expect(costMicro({ inputTokens: 1001, outputTokens: 1000, ...PRICE_7B })).toBe(251);
    });
    it("a charge never exceeds the item's max", () => {
        const max = itemMaxCostMicro({ inputTokens: 10, maxTokens: 5, ...PRICE_7B });
        const it2 = { input_tokens: 10, max_tokens: 5, max_cost_micro: max };
        expect(itemChargeMicro({ item: it2, result: { text: "x".repeat(10_000) }, price: PRICE_7B }).chargeMicro).toBe(max);
        expect(itemChargeMicro({ item: it2, result: { text: "abcd" }, price: PRICE_7B })).toEqual({ outputTokens: 1, chargeMicro: 1 });
    });
    it("provider gets the charge less the house fee (fee rounded up)", () => {
        expect(providerSplitMicro(1_000_000, 2)).toEqual({ feeMicro: 20_000, providerMicro: 980_000 });
        // Rounding favours the operator: a 1-micro charge pays them 1, not 0.
        expect(providerSplitMicro(1, 2)).toEqual({ feeMicro: 0, providerMicro: 1 });
        expect(providerSplitMicro(151, 2)).toEqual({ feeMicro: 3, providerMicro: 148 });
        for (const c of [1, 7, 49, 50, 51, 99, 101, 12345, 999_999]) {
            const { providerMicro, feeMicro } = providerSplitMicro(c, 2);
            expect(providerMicro + feeMicro).toBe(c);
            expect(providerMicro).toBeGreaterThanOrEqual(Math.ceil(c * 0.98) - 1);
            expect(providerMicro * 100).toBeGreaterThanOrEqual(c * 98);
        }
        expect(providerSplitMicro(0, 2)).toEqual({ feeMicro: 0, providerMicro: 0 });
        expect(providerSplitMicro(100, 0)).toEqual({ feeMicro: 0, providerMicro: 100 });
    });
});

describe("pricing config + kill switch", () => {
    it("defaults, settings override, bad values fall back", () => {
        const d = resolveInferencePricing({ env: {} });
        expect(d.enabled).toBe(true);
        expect(d.models["qwen2.5:7b"]).toEqual({ input_per_m_usd: 0.05, output_per_m_usd: 0.2 });
        expect(d).toMatchObject({ min_topup_usd: 5, max_items_per_batch: 1000, max_tokens_cap: 4096, max_in_flight: 8 });
        expect(resolveInferencePricing({ env: {}, settings: { enabled: false } }).enabled).toBe(false);
        expect(resolveInferencePricing({ env: { INFERNET_INFERENCE_PRICING_ENABLED: "false" } }).enabled).toBe(false);
        const bad = resolveInferencePricing({ env: {}, settings: { models: { m: { input_per_m_usd: -1, output_per_m_usd: 1 } }, max_tokens_cap: 1e9 } });
        expect(bad.models).toEqual(DEFAULT_INFERENCE_PRICING.models);
        expect(bad.max_tokens_cap).toBe(4096);
    });
    it("admin patches are validated", () => {
        expect(validatePricingPatch({ enabled: "no" }, d0()).ok).toBe(false);
        expect(validatePricingPatch({ max_items_per_batch: 0 }, d0()).ok).toBe(false);
        const v = validatePricingPatch({ enabled: false, models: { "qwen2.5:7b": { input_per_m_usd: 0.1, output_per_m_usd: 0.3 } } }, d0());
        expect(v.ok && v.value.enabled === false && v.value.models["qwen2.5:7b"].input_per_m_usd === 0.1).toBe(true);
    });
});
const d0 = () => resolveInferencePricing({ env: {} });

describe("validateBatch", () => {
    const pricing = d0();
    const sellable = new Set(["qwen2.5:7b"]);
    it("prices a valid batch", () => {
        const v = validateBatch({ model: "qwen2.5:7b", items: [item("a"), item("b", "x", 4096)] }, { pricing, sellable });
        expect(v.ok).toBe(true);
        expect(v.value.items[0]).toMatchObject({ custom_id: "a", input_tokens: 3, max_tokens: 100, max_cost_micro: costMicro({ inputTokens: 3, outputTokens: 100, ...PRICE_7B }) });
    });
    it("rejects an unpriced model and a priced model no live node serves", () => {
        expect(validateBatch({ model: "llama3.1:70b", items: [item("a")] }, { pricing, sellable })).toMatchObject({ ok: false, status: 400 });
        expect(validateBatch({ model: "qwen2.5:0.5b", items: [item("a")] }, { pricing, sellable })).toMatchObject({ ok: false, status: 409 });
    });
    it("kill switch: disabled pricing refuses everything", () => {
        expect(validateBatch({ model: "qwen2.5:7b", items: [item("a")] }, { pricing: { ...pricing, enabled: false }, sellable })).toMatchObject({ ok: false, status: 503 });
    });
    it("enforces item count, max_tokens cap, unique custom_id, message shape", () => {
        const tooMany = Array.from({ length: 3 }, (_, i) => item(`i${i}`));
        expect(validateBatch({ model: "qwen2.5:7b", items: tooMany }, { pricing: { ...pricing, max_items_per_batch: 2 }, sellable }).ok).toBe(false);
        expect(validateBatch({ model: "qwen2.5:7b", items: [item("a", "x", 4097)] }, { pricing, sellable }).errors[0]).toMatch(/cap/);
        expect(validateBatch({ model: "qwen2.5:7b", items: [item("a"), item("a")] }, { pricing, sellable }).errors[0]).toMatch(/repeated/);
        expect(validateBatch({ model: "qwen2.5:7b", items: [{ custom_id: "a", messages: [{ role: "tool", content: "x" }], max_tokens: 5 }] }, { pricing, sellable }).ok).toBe(false);
    });
    it("quote view totals", () => {
        const v = validateBatch({ model: "qwen2.5:7b", items: [item("a"), item("b")] }, { pricing, sellable });
        const q = quoteView({ id: "q", model: "qwen2.5:7b", price: v.value.price, items: v.value.items, expiresAt: "x" });
        expect(q.total_max_cost_usd).toBe(microToUsd(v.value.items[0].max_cost_micro * 2));
        expect(q.token_counts).toMatch(/server-side estimates/);
    });
});

describe("top-up amounts", () => {
    it("whole cents, at least the minimum", () => {
        expect(parseTopupAmount("5", 5)).toMatchObject({ ok: true, micro: 5_000_000, usd: "5.00" });
        expect(parseTopupAmount(4.99, 5).ok).toBe(false);
        expect(parseTopupAmount("5.001", 5).ok).toBe(false);
        expect(parseTopupAmount("20000", 5).ok).toBe(false);
    });
});

// ---- ledger invariants (pure mirror of the SQL; SQL itself: tooling/test-paid-batch-sql.sh) ----

describe("hold / charge / release invariants", () => {
    it("never lets available go negative, over many random operations", () => {
        let rng = 7;
        const rand = (n) => { rng = (rng * 1103515245 + 12345) % 2 ** 31; return rng % n; };
        let a = { balance: 0, held: 0 };
        const open = [];
        for (let i = 0; i < 5000; i++) {
            const op = rand(3);
            if (op === 0) a = ledger.topup(a, rand(1000));
            if (op === 1) {
                const want = rand(800);
                const r = ledger.hold(a, want);
                if (r.ok) { a = r.account; open.push(want); }
                else expect(ledger.available(a)).toBeLessThan(want);
            }
            if (op === 2 && open.length) {
                const maxCost = open.pop();
                const s = ledger.settle(a, { maxCost, cost: rand(1200), completed: rand(2) === 1 });
                expect(s.charge + s.release).toBe(maxCost);
                expect(s.charge).toBeLessThanOrEqual(maxCost);
                a = s.account;
            }
            expect(ledger.available(a)).toBeGreaterThanOrEqual(0);
            expect(a.held).toBeGreaterThanOrEqual(0);
        }
    });
    it("failed and cancelled items charge nothing and release the whole hold", () => {
        expect(ledger.settle({ balance: 10, held: 5 }, { maxCost: 5, cost: 3, completed: false })).toEqual({ charge: 0, release: 5, account: { balance: 10, held: 0 } });
    });
});

// ---- funding sources ------------------------------------------------------------

describe("funding order", () => {
    it("parses presets, lists and the account default", () => {
        expect(parseFunding(undefined, null).sources).toEqual(["earned", "prepaid", "wallet"]);
        expect(parseFunding(undefined, ["prepaid"]).sources).toEqual(["prepaid"]);
        expect(parseFunding("prepaid_first").sources).toEqual(["prepaid", "earned", "wallet"]);
        expect(parseFunding("prepaid_only").sources).toEqual(["prepaid"]);
        expect(parseFunding(["wallet", "earned"]).sources).toEqual(["wallet", "earned"]);
        expect(parseFunding(["earned", "earned"]).ok).toBe(false);
        expect(parseFunding("free").ok).toBe(false);
    });
    it("earned first takes earnings before the balance; prepaid first the reverse", () => {
        expect(planFunding({ sources: ["earned", "prepaid", "wallet"], totalMicro: 10, earnedMicro: 6, prepaidMicro: 100 })).toMatchObject({ earned: 6, prepaid: 4, shortfall: 0 });
        expect(planFunding({ sources: ["prepaid", "earned"], totalMicro: 10, earnedMicro: 6, prepaidMicro: 7 })).toMatchObject({ earned: 3, prepaid: 7, shortfall: 0 });
    });
    it("only-sources never touch the others; the wallet covers the shortfall", () => {
        expect(planFunding({ sources: ["prepaid"], totalMicro: 10, earnedMicro: 100, prepaidMicro: 4 })).toMatchObject({ earned: 0, shortfall: 6, walletAllowed: false });
        expect(planFunding({ sources: ["earned"], totalMicro: 10, earnedMicro: 3, prepaidMicro: 100 })).toMatchObject({ prepaid: 0, shortfall: 7 });
        const before = planFunding({ sources: ["earned", "prepaid", "wallet"], totalMicro: 10, earnedMicro: 2, prepaidMicro: 3 });
        expect(before).toMatchObject({ shortfall: 5, walletAllowed: true });
        // after the wallet paid the shortfall (credited to the balance first)
        expect(planFunding({ sources: ["earned", "prepaid", "wallet"], totalMicro: 10, earnedMicro: 2, prepaidMicro: 8, walletMicro: 5 })).toMatchObject({ earned: 2, prepaid: 3, wallet: 5, shortfall: 0 });
        expect(shortfallCents(5)).toBe(1);
        expect(shortfallCents(10_000)).toBe(1);
        expect(shortfallCents(10_001)).toBe(2);
    });
    it("receipts say which source paid (earned first) and what went back", () => {
        const f = fundingBreakdown({ hold_micro: 10_000_000, funded_earned_micro: 4_000_000, funded_wallet_micro: 1_000_000, charged_micro: 4_500_000, returned_earned_micro: 0 });
        expect(f.held_from).toEqual({ earned_usd: "4.000000", wallet_usd: "1.000000", prepaid_usd: "5.000000" });
        expect(f.paid_from).toEqual({ earned_usd: "4.000000", wallet_usd: "0.500000", prepaid_usd: "0.000000" });
    });
});

describe("earnings: batch jobs and spends", () => {
    const cfg = { ...DEFAULT_EARNINGS_CONFIG };
    it("a prepaid batch job never earns a subsidy (or a payment_offer credit)", () => {
        expect(computeJobCredits({ job: { id: "j", provider_id: "p", payment_offer: 0, batch_item_id: "i" }, result: { token_count: 50 }, config: cfg })).toEqual([]);
        expect(computeJobCredits({ job: { id: "j", provider_id: "p", payment_offer: 0, billing: "prepaid_batch" }, result: { text: "abc" }, config: cfg })).toEqual([]);
        expect(computeJobCredits({ job: { id: "j", provider_id: "p", payment_offer: 0 }, result: { text: "abcd" }, config: cfg })).toHaveLength(1);
    });
    it("money spent on compute is not withdrawable; returns come back; pending never counts", () => {
        const b = summariseBalance([
            { kind: "subsidy", status: "confirmed", amount_usd: 3 },
            { kind: "subsidy", status: "pending_approval", amount_usd: 5 },
            { kind: "paid", status: "pending", amount_usd: 2 },
            { kind: "spent_on_compute", status: "confirmed", amount_usd: -2 },
            { kind: "spent_on_compute", status: "confirmed", amount_usd: 1.7 }
        ], [{ status: "sent", amount_usd: 0.5 }]);
        expect(b.available_usd).toBe(2.2);
        expect(b.spent_on_compute_usd).toBe(0.3);
        expect(b.jobs_credited).toBe(3);
    });
});

describe("revenue counts batch charges as GMV, not top-ups", () => {
    it("adds external charges, splits the fee, keeps internal accounts out", () => {
        const out = summariseRevenue({
            config: { house_fee_pct: 2 },
            internal: { emails: ["me@house.com"] },
            batchCharges: [
                { cost_usd: 1, provider_usd: 0.98, email: "buyer@x.com" },
                { cost_usd: 0.5, provider_usd: null, email: "node-owner@x.com" },
                { cost_usd: 9, provider_usd: 8.82, email: "ME@house.com" }
            ]
        });
        expect(out.batches).toEqual({ charged_items: 2, gmv_usd: 1.5, provider_share_usd: 1.47, platform_fee_usd: 0.03, internal_items: 1, internal_usd: 9 });
        expect(out.gmv_usd).toBe(1.5);
        expect(out.platform_fee_usd).toBe(0.03);
    });
});

// ---- DB-backed paths (fake Supabase; ledger functions stubbed) ---------------------

describe("quote and submit", () => {
    it("quote stores the priced items, expires in 15 minutes, never calls a ledger function", async () => {
        const q = await batches.createQuote(USER, { model: "qwen2.5:7b", items: [item("a")] });
        expect(Date.parse(q.expires_at) - Date.now()).toBeGreaterThan(QUOTE_TTL_MS - 5000);
        expect(fake.db.tables.inference_batch_quotes).toHaveLength(1);
        expect(fake.db.rpcCalls).toEqual([]);
    });

    it("kill switch stops quotes and submits", async () => {
        freshFake({ pricing: { enabled: false } });
        await expect(batches.createQuote(USER, { model: "qwen2.5:7b", items: [item("a")] })).rejects.toMatchObject({ status: 503 });
        await expect(batches.prepareSubmit(USER, { model: "qwen2.5:7b", items: [item("a")], max_cost_usd: "1", idempotency_key: "k" })).rejects.toMatchObject({ status: 503 });
    });

    it("refuses an unsellable model (no live node)", async () => {
        freshFake({ providers: [liveProvider(["llama3.2:3b"])] });
        await expect(batches.createQuote(USER, { model: "qwen2.5:7b", items: [item("a")] })).rejects.toMatchObject({ status: 409 });
        freshFake({ providers: [{ ...liveProvider(), disabled_at: "2026-11-01" }] });
        await expect(batches.createQuote(USER, { model: "qwen2.5:7b", items: [item("a")] })).rejects.toMatchObject({ status: 409 });
    });

    it("requires max_cost_usd and idempotency_key, and enforces the cap", async () => {
        await expect(batches.prepareSubmit(USER, { model: "qwen2.5:7b", items: [item("a")], max_cost_usd: "1" })).rejects.toMatchObject({ status: 400 });
        await expect(batches.prepareSubmit(USER, { model: "qwen2.5:7b", items: [item("a")], idempotency_key: "k" })).rejects.toMatchObject({ status: 400 });
        await expect(batches.prepareSubmit(USER, { model: "qwen2.5:7b", items: [item("a", "x", 4096)], max_cost_usd: "0.000001", idempotency_key: "k" }))
            .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/above max_cost_usd/) });
    });

    it("the same idempotency key returns the existing batch without pricing again", async () => {
        fake.db.tables.inference_batches.push({ id: "b-1", user_id: USER.id, idempotency_key: "k", status: "running" });
        freshFakeKeep({ pricing: { enabled: false } });
        const p = await batches.prepareSubmit(USER, { idempotency_key: "k" });
        expect(p.existing.id).toBe("b-1");
    });

    it("an expired or foreign quote is refused", async () => {
        const q = await batches.createQuote(USER, { model: "qwen2.5:7b", items: [item("a")] });
        await expect(batches.prepareSubmit({ id: "someone-else" }, { quote_id: q.quote_id, max_cost_usd: "1", idempotency_key: "k" })).rejects.toMatchObject({ status: 404 });
        fake.db.tables.inference_batch_quotes[0].expires_at = new Date(Date.now() - 1000).toISOString();
        await expect(batches.prepareSubmit(USER, { quote_id: q.quote_id, max_cost_usd: "1", idempotency_key: "k" })).rejects.toMatchObject({ status: 410 });
    });

    it("commit places the hold via SQL with the funding order and dispatches only claimed items", async () => {
        const rpc = {
            inference_submit_batch: vi.fn(async ({ p_items }, db) => {
                db.tables.inference_batches.push({ id: "22222222-2222-2222-2222-222222222222", user_id: USER.id, status: "running", model: "qwen2.5:7b", hold_micro: 1, charged_micro: 0, released_micro: 0, max_cost_micro: 1e6, input_micro_per_m: 1, output_micro_per_m: 1, house_fee_pct: 2 });
                p_items.forEach((it, i) => db.tables.inference_batch_items.push({ ...it, id: `it-${i}`, batch_id: "22222222-2222-2222-2222-222222222222", status: "queued", attempts: 0 }));
                return { ok: true, batch_id: "22222222-2222-2222-2222-222222222222", existing: false };
            }),
            // the SQL bounds this to max_in_flight; here: 1 of 3
            inference_claim_items: vi.fn(async (_a, db) => {
                const it2 = db.tables.inference_batch_items[0];
                it2.status = "dispatched";
                it2.attempts = 1;
                return [it2];
            })
        };
        freshFakeKeep({ rpc });
        chat.pickChatProvider.mockResolvedValue({ id: "prov-1" });
        chat.createChatJob.mockResolvedValue({ job: { id: "job-1" }, source: "p2p" });
        const p = await batches.prepareSubmit(USER, { model: "qwen2.5:7b", items: [item("a"), item("b"), item("c")], max_cost_usd: "1", idempotency_key: "k2", funding: "prepaid_only" });
        const r = await batches.commitSubmit(USER, p, { walletMicro: 0 });
        expect(r.ok).toBe(true);
        const call = rpc.inference_submit_batch.mock.calls[0][0];
        expect(call.p_batch).toMatchObject({ funding: ["prepaid"], wallet_micro: 0, house_fee_pct: 5, max_in_flight: 8 });
        expect(chat.createChatJob).toHaveBeenCalledTimes(1);
        expect(chat.createChatJob.mock.calls[0][0]).toMatchObject({ providerId: "prov-1", pinned: true, batchItemId: "it-0", modelName: "qwen2.5:7b", maxTokens: 100 });
        expect(fake.db.tables.inference_batch_items[0].job_id).toBe("job-1");
    });

    it("no free node: the claimed item goes back to the queue, no job", async () => {
        const rpc = {
            inference_claim_items: async () => [{ id: "it-x", attempts: 1, input: { messages: msgs("hi") }, max_tokens: 5 }],
            inference_settle_item: vi.fn(async () => ({ settled: false, requeued: true }))
        };
        freshFakeKeep({ rpc });
        fake.db.tables.inference_batches.push({ id: "33333333-3333-3333-3333-333333333333", status: "running", model: "qwen2.5:7b" });
        chat.pickChatProvider.mockResolvedValue(null);
        await batches.dispatchBatch("33333333-3333-3333-3333-333333333333");
        expect(chat.createChatJob).not.toHaveBeenCalled();
        expect(rpc.inference_settle_item.mock.calls[0][0]).toMatchObject({ p_item_id: "it-x", p_status: "requeue" });
    });
});

function freshFakeKeep({ pricing, rpc } = {}) {
    if (pricing) fake.db.tables.settings = [{ key: "inference_pricing", value: pricing }];
    const tables = fake.db.tables;
    fake = createFakeSupabase({ tables, rpc: rpc ?? {} });
}

describe("settling an item", () => {
    function setup(settleResult) {
        const rpc = {
            inference_settle_item: vi.fn(async () => settleResult),
            inference_claim_items: async () => []
        };
        freshFake({ rpc });
        fake.db.tables.inference_batches.push({ id: "b", status: "running", model: "qwen2.5:7b" });
        fake.db.tables.inference_batch_items.push({
            id: "it", batch_id: "b", status: "dispatched", max_tokens: 100, input_tokens: 10, max_cost_micro: 30_000, job_id: "job",
            inference_batches: { id: "b", model: "qwen2.5:7b", status: "running", house_fee_pct: 2, input_micro_per_m: 50_000, output_micro_per_m: 200_000 }
        });
        return rpc;
    }

    it("charges the server estimate (not the provider's token_count) and credits the provider confirmed 'paid'", async () => {
        const rpc = setup({ settled: true, charged_micro: 2, batch_done: false });
        const job = { id: "job", batch_item_id: "it", provider_id: "prov-1", model_name: "qwen2.5:7b" };
        await batches.settleBatchJob({ job, result: { text: "abcdefgh", token_count: 9999 }, failed: false });
        // 10 in x 0.05 + 2 out x 0.20 = 0.9 micro -> 1? (10*50000 + 2*200000)/1e6 = 0.9 -> rounds up to 1
        expect(rpc.inference_settle_item.mock.calls[0][0]).toMatchObject({ p_status: "completed", p_output_tokens: 2, p_cost_micro: 1, p_job_id: "job" });
        const [e] = fake.db.tables.provider_earnings;
        expect(e).toMatchObject({ job_id: "job", provider_id: "prov-1", kind: "paid", status: "confirmed", gross_usd: "0.000002", tokens_estimated: true });
        expect(e.metadata).toMatchObject({ source: "prepaid_batch", batch_id: "b" });
    });

    it("a replay (already settled) credits nothing more", async () => {
        setup({ settled: false, reason: "already" });
        await batches.settleBatchJob({ job: { id: "job", batch_item_id: "it", provider_id: "prov-1" }, result: { text: "abcd" }, failed: false });
        expect(fake.db.tables.provider_earnings).toHaveLength(0);
    });

    it("a failed item charges 0 and the provider earns nothing", async () => {
        const rpc = setup({ settled: true, charged_micro: 0, batch_done: true });
        await batches.settleBatchJob({ job: { id: "job", batch_item_id: "it", provider_id: "prov-1" }, result: { error: "boom" }, failed: true });
        expect(rpc.inference_settle_item.mock.calls[0][0]).toMatchObject({ p_status: "failed", p_cost_micro: 0 });
        expect(fake.db.tables.provider_earnings).toHaveLength(0);
    });

    it("cancel is only for the owner", async () => {
        freshFake({ rpc: { inference_cancel_batch: vi.fn(async () => ({ ok: true, cancelled_items: 2 })) } });
        fake.db.tables.inference_batches.push({ id: "11111111-1111-1111-1111-111111111111", user_id: USER.id, status: "running" });
        await expect(batches.cancelBatch({ id: "other" }, "11111111-1111-1111-1111-111111111111")).rejects.toMatchObject({ status: 404 });
        const r = await batches.cancelBatch(USER, "11111111-1111-1111-1111-111111111111");
        expect(r.cancelled_items).toBe(2);
    });
});

describe("top-ups: credited exactly once and only when CoinPay says paid", () => {
    const topup = () => ({ id: "t-1", user_id: USER.id, status: "awaiting_payment", amount_usd: "5.00", payment_ref: "cs_1" });

    it("not verified: nothing is credited", async () => {
        const credit = vi.fn(async () => ({ credited: true }));
        freshFake({ rpc: { billing_credit_topup: credit } });
        for (const verdict of ["unpaid", "unknown"]) {
            const s = await billing.settleTopup(topup(), { verify: async () => ({ verdict }) });
            expect(s).toMatchObject({ verdict, credited: false });
        }
        expect(credit).not.toHaveBeenCalled();
    });

    it("verified: one credit call; the SQL status flip makes a racing replay a no-op", async () => {
        let flips = 0;
        freshFake({ rpc: { billing_credit_topup: async () => ({ credited: flips++ === 0 }) } });
        const verify = async () => ({ verdict: "paid", txHash: "0xabc" });
        const [a, b] = await Promise.all([billing.settleTopup(topup(), { verify }), billing.settleTopup(topup(), { verify })]);
        expect([a.credited, b.credited].sort()).toEqual([false, true]);
    });

    it("an already-paid top-up is never re-verified or re-credited", async () => {
        const credit = vi.fn();
        freshFake({ rpc: { billing_credit_topup: credit } });
        const verify = vi.fn();
        const s = await billing.settleTopup({ ...topup(), status: "paid" }, { verify });
        expect(s.credited).toBe(false);
        expect(verify).not.toHaveBeenCalled();
        expect(credit).not.toHaveBeenCalled();
    });
});

describe("receipt", () => {
    it("totals tokens, charge and the provider/platform split", () => {
        const r = buildReceipt({
            batch: { id: "b", model: "m", status: "completed", charged_micro: 1000, released_micro: 9000, hold_micro: 10_000, max_cost_micro: 10_000, input_micro_per_m: 50_000, output_micro_per_m: 200_000, house_fee_pct: 2, funded_earned_micro: 0 },
            items: [
                { status: "completed", settled_at: "x", input_tokens: 10, output_tokens: 4 },
                { status: "failed", settled_at: "x", input_tokens: 99, output_tokens: 0 }
            ],
            providerMicro: 980
        });
        expect(r).toMatchObject({ estimated_input_tokens: 10, estimated_output_tokens: 4, total_charged_usd: "0.001000", provider_share_usd: "0.000980", platform_fee_usd: "0.000020" });
        expect(r.items).toMatchObject({ total: 2, completed: 1, failed: 1 });
    });
});

describe("CLI + MCP surfaces", () => {
    it("reads JSONL, one request per line", () => {
        expect(readBatchJsonl('{"custom_id":"a","messages":[],"max_tokens":1}\n\n{"custom_id":"b","messages":[],"max_tokens":1}\n')).toHaveLength(2);
        expect(() => readBatchJsonl("{bad")).toThrow(/line 1/);
        expect(() => readBatchJsonl("\n")).toThrow(/no items/);
    });
    it("batch_submit needs an explicit max_cost_usd and never pays from a wallet", async () => {
        const submit = vi.fn(async (b) => b);
        const tool = TOOLS.find((t) => t.name === "batch_submit");
        expect(tool.inputSchema.required).toEqual(["max_cost_usd", "idempotency_key"]);
        await expect(tool.run({ batch: { submit } }, { idempotency_key: "k", quote_id: "q" })).rejects.toThrow(/max_cost_usd/);
        await tool.run({ batch: { submit } }, { idempotency_key: "k", quote_id: "q", max_cost_usd: 2 });
        expect(submit).toHaveBeenCalledWith({ max_cost_usd: "2", idempotency_key: "k", funding: "no_wallet", quote_id: "q" });
        for (const n of ["batch_quote", "batch_status", "batch_results"]) expect(TOOLS.some((t) => t.name === n)).toBe(true);
    });
    it("client sends the API key and reports 402 bodies", async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "insufficient balance", shortfall_usd: "1.000000" }), { status: 402 }));
        const c = createBatchClient({ baseUrl: "https://x", apiKey: "ik_live_abc", fetchImpl });
        await expect(c.submit({})).rejects.toMatchObject({ status: 402, body: { shortfall_usd: "1.000000" } });
        expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe("Bearer ik_live_abc");
    });
});
