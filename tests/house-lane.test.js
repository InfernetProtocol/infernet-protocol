import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createFakeSupabase } from "./fixtures/fake-supabase.js";
import { validateReservationInput, MAX_HOUSE_LANE_HOURS } from "../apps/web/lib/reservations/core.js";
import { retainedSpec, houseLaneBillingOk, houseLaneBalanceError } from "../apps/web/lib/reservations/house-lane.js";

/**
 * House-lane reservations (migration 20261122220000): confidential inference
 * pinned to a node the house operates, paid per request by the person a
 * trusted client names, with nothing kept.
 *
 * What must hold:
 *   - only a registered trusted client may use the lane, and it must name a
 *     subject; a caller without a balance is refused (402), never served free;
 *   - the job is pinned to the reservation's node, billed to the caller and
 *     marked no-retain; if that node cannot take it the answer is 503 and no
 *     other node is tried (fail closed);
 *   - the prompt, answer and token stream are purged once the request ends;
 *   - an ordinary reservation is unchanged.
 */

const TRUSTED_KEY = "ifc_" + "h".repeat(48);
const UNREGISTERED_KEY = "ifc_" + "u".repeat(48);
const RES_KEY = "ifr_res_" + "k".repeat(40);
const SUB = "cp-sub-house";
const USER = "33333333-3333-4333-8333-333333333333";
const NODE = "a61e5f0b-447a-421a-b1a1-37fde20c94ab";
const OTHER_NODE = "99e72fd9-5972-4ee5-b104-91ea6b2bdce9";
const MODEL = "qwen3:4b";

process.env.INFERNET_TRUSTED_CLIENT_KEYS = `c0mpute:${createHash("sha256").update(TRUSTED_KEY).digest("hex")}`;

const state = {};
const createChatJob = vi.fn();
const purgeJobContent = vi.fn(async () => ({ purged: true }));
let fake;

function reservation(over = {}) {
    const start = new Date(Math.floor(Date.now() / 3600_000) * 3600_000).toISOString();
    return {
        id: "44444444-4444-4444-8444-444444444444",
        name: "house-lane", operator_name: "Profullstack", target_kind: "node",
        provider_id: NODE, endpoint_url: null, models: [MODEL], start_at: start, hours: 8784,
        included_tokens: 0, tokens_used: 0, per_key_rps: 100, per_key_concurrency: 4,
        shared_rps: 100, shared_concurrency: 4, required_minutes_per_hour: 60, status: "scheduled",
        house_lane: true,
        ...over
    };
}

vi.mock("@/lib/data/reservations", () => ({
    resolveKey: async () => ({ reservation: state.reservation, key: { id: "key-1" } }),
    recordUsage: async () => {},
    addTokens: async () => {},
    reserveTokens: async () => ({ ok: true }),
    settleTokens: async () => {}
}));
vi.mock("@/lib/data/blocklists", () => ({ getModelDenylist: async () => [] }));
vi.mock("@/lib/data/chat", () => ({ createChatJob: (...a) => createChatJob(...a) }));
vi.mock("@/lib/data/chat-stream", () => ({
    streamJobEvents: async function* () {
        yield { type: "token", data: { text: "Your A1c was 6.1%." } };
        if (state.noEnd) return;
        yield { type: "done", data: {} };
    }
}));
vi.mock("@/lib/data/interactive-billing", () => ({
    userIdForCoinpaySubject: async (sub) => state.subjects[sub] ?? null,
    authorizeInteractive: async () => state.billing
}));
vi.mock("@/lib/data/job-retention", () => ({ purgeJobContent: (...a) => purgeJobContent(...a) }));
vi.mock("@/lib/data/reservation-upstream", () => ({ forwardToEndpoint: async () => { throw new Error("no endpoint in this test"); } }));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fake }));

const { serveChatCompletion } = await import("../apps/web/lib/reservations/serve.js");

function request(headers = {}, body = {}) {
    return new Request("https://infernetprotocol.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${RES_KEY}`, "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "what was my last A1c?" }], ...body })
    });
}
const houseHeaders = (over = {}) => ({ "x-infernet-client-key": TRUSTED_KEY, "x-infernet-billed-subject": SUB, ...over });

beforeEach(() => {
    state.noEnd = false;
    state.reservation = reservation();
    state.subjects = { [SUB]: USER };
    state.billing = { mode: "balance", spendable_usd: "1.000000" };
    createChatJob.mockReset();
    createChatJob.mockImplementation(async () => ({ source: "p2p", job: { id: "job-1", provider_id: NODE } }));
    purgeJobContent.mockClear();
    fake = createFakeSupabase({ tables: { billing_ledger: [{ idem_key: "job:job-1:charge", amount_micro: 1234 }] } });
});

describe("house-lane reservation input", () => {
    const base = { name: "house", operator_name: "Profullstack", models: [MODEL], provider_id: NODE, start_at: "2026-11-22T20:00:00.000Z" };

    it("lets a house lane run a year, but keeps everything else at 30 days", () => {
        const house = validateReservationInput({ ...base, hours: MAX_HOUSE_LANE_HOURS, house_lane: true });
        expect(house.ok).toBe(true);
        expect(house.value.house_lane).toBe(true);
        expect(validateReservationInput({ ...base, hours: MAX_HOUSE_LANE_HOURS }).ok).toBe(false);
        expect(validateReservationInput({ ...base, hours: 720 }).value.house_lane).toBe(false);
    });

    it("refuses an endpoint target: a house lane runs on a node we operate", () => {
        const r = validateReservationInput({ ...base, provider_id: undefined, endpoint_url: "https://op.example/v1", hours: 1, house_lane: true });
        expect(r.ok).toBe(false);
        expect(r.errors.join(" ")).toMatch(/house_lane needs a node/);
    });
});

describe("house-lane helpers", () => {
    it("keeps only billing counts after a purge", () => {
        const kept = retainedSpec({ messages: [{ role: "user", content: "secret" }], billing: "interactive_balance", input_tokens: 12, max_tokens: 512, temperature: 0.2, no_retain: true });
        expect(kept).toEqual({ no_retain: true, purged: true, billing: "interactive_balance", input_tokens: 12, max_tokens: 512 });
        expect(JSON.stringify(kept)).not.toMatch(/secret/);
        expect(retainedSpec(null)).toEqual({ no_retain: true, purged: true });
    });

    it("is paid only", () => {
        expect(houseLaneBillingOk({ mode: "balance" })).toBe(true);
        expect(houseLaneBillingOk({ mode: "admin" })).toBe(true);
        for (const mode of ["free", "insufficient", undefined]) expect(houseLaneBillingOk({ mode })).toBe(false);
        expect(houseLaneBillingOk({ mode: "free", degraded: true })).toBe(false);
        expect(houseLaneBalanceError({ spendable_usd: "0.000000" }).status).toBe(402);
    });
});

describe("serveChatCompletion on a house-lane reservation", () => {
    it("refuses a caller without the trusted client key", async () => {
        const res = await serveChatCompletion(request(), RES_KEY);
        expect(res.status).toBe(403);
        expect((await res.json()).error.code).toBe("house_lane_client_required");
        expect(createChatJob).not.toHaveBeenCalled();
    });

    it("refuses a key that is not a registered trusted client", async () => {
        const res = await serveChatCompletion(request(houseHeaders({ "x-infernet-client-key": UNREGISTERED_KEY })), RES_KEY);
        expect(res.status).toBe(403);
        expect(createChatJob).not.toHaveBeenCalled();
    });

    it("refuses a trusted client that names no one", async () => {
        const res = await serveChatCompletion(request({ "x-infernet-client-key": TRUSTED_KEY }), RES_KEY);
        expect(res.status).toBe(403);
        expect((await res.json()).error.code).toBe("house_lane_subject_required");
    });

    it("refuses (402) a subject with no Infernet account: never the free tier", async () => {
        state.subjects = {};
        const res = await serveChatCompletion(request(houseHeaders()), RES_KEY);
        expect(res.status).toBe(402);
        expect((await res.json()).error.reason).toBe("balance_required");
        expect(createChatJob).not.toHaveBeenCalled();
    });

    it("refuses (402) a caller whose billing resolves to free or degraded", async () => {
        for (const billing of [{ mode: "free", reason: "empty" }, { mode: "free", degraded: true }, { mode: "insufficient" }]) {
            state.billing = billing;
            const res = await serveChatCompletion(request(houseHeaders()), RES_KEY);
            expect(res.status).toBe(402);
        }
        expect(createChatJob).not.toHaveBeenCalled();
    });

    it("pins the job to the house node, bills the caller, keeps nothing, and reports the charge", async () => {
        const res = await serveChatCompletion(request(houseHeaders()), RES_KEY);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-infernet-lane")).toBe("house");
        const args = createChatJob.mock.calls[0][0];
        expect(args).toMatchObject({ providerId: NODE, pinned: true, billedUserId: USER, noRetain: true, modelName: MODEL });
        const body = await res.json();
        expect(body.choices[0].message.content).toBe("Your A1c was 6.1%.");
        expect(body.x_infernet).toMatchObject({ lane: "house", billed: true, charged_micro: 1234, charged_usd: "0.001234" });
        expect(purgeJobContent).toHaveBeenCalledWith("job-1");
    });

    it("streams with the receipt chunk and purges after", async () => {
        const res = await serveChatCompletion(request(houseHeaders(), { stream: true }), RES_KEY);
        const text = await res.text();
        expect(text).toContain("Your A1c was 6.1%.");
        expect(text).toContain('"object":"infernet.house"');
        expect(text.trim().endsWith("data: [DONE]")).toBe(true);
        expect(purgeJobContent).toHaveBeenCalledWith("job-1");
    });

    it("keeps the prompt for a job the node has not finished (caller left); the sweep purges it later", async () => {
        state.noEnd = true;
        const res = await serveChatCompletion(request(houseHeaders(), { stream: true }), RES_KEY);
        await res.text();
        expect(purgeJobContent).not.toHaveBeenCalled();
    });

    it("fails closed (503) when the house node cannot take it, and tries no other node", async () => {
        createChatJob.mockImplementation(async () => ({ source: "none", job: { id: "job-2", provider_id: null } }));
        const res = await serveChatCompletion(request(houseHeaders()), RES_KEY);
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe("pinned_node_unavailable");
        expect(createChatJob).toHaveBeenCalledTimes(1);
        expect(purgeJobContent).toHaveBeenCalledWith("job-2");
    });

    it("fails closed when a job lands on any other node", async () => {
        createChatJob.mockImplementation(async () => ({ source: "p2p", job: { id: "job-3", provider_id: OTHER_NODE } }));
        const res = await serveChatCompletion(request(houseHeaders()), RES_KEY);
        expect(res.status).toBe(503);
    });
});

describe("an ordinary reservation", () => {
    it("is served as before: not billed to a person, content kept", async () => {
        state.reservation = reservation({ house_lane: false });
        const res = await serveChatCompletion(request(), RES_KEY);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-infernet-lane")).toBeNull();
        const args = createChatJob.mock.calls[0][0];
        expect(args.billedUserId).toBeUndefined();
        expect(args.noRetain).toBeUndefined();
        expect(purgeJobContent).not.toHaveBeenCalled();
    });
});
