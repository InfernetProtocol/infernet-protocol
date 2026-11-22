import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createFakeSupabase } from "./fixtures/fake-supabase.js";
import {
    DEFAULT_TOPUP_RETURN_ORIGINS,
    topupReturnOrigins,
    isAllowedReturnUrl,
    parseReturnUrls
} from "../apps/web/lib/billing/topup-return.js";

/**
 * POST /api/v1/billing/topup and GET /api/v1/billing/topup/:id for a trusted
 * client (c0mpute.com's own checkout page).
 *
 * What must hold: a trusted key acts only for the subject it names; a bearer
 * that is not a registered trusted key gains nothing by sending the subject
 * header; return URLs go only to an allowlisted https origin, and only a
 * trusted client may set them at all; an ordinary caller's top-up is opened
 * exactly as before.
 */

const TRUSTED_KEY = "ifc_" + "c".repeat(48);
const UNREGISTERED_KEY = "ifc_" + "d".repeat(48);
const SUB = "cp-sub-1";
const LINKED_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const PLACEHOLDER = "cp-abc123@coinpay-users.infernetprotocol.com";

const state = { subjects: {}, caller: null, authEmails: {} };
let fake;
const createCheckout = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
    getSupabaseServerClient: () => ({
        ...fake,
        auth: {
            admin: {
                getUserById: async (id) => ({ data: { user: id in state.authEmails ? { id, email: state.authEmails[id] } : null }, error: null })
            }
        }
    })
}));
// By file: the package is a dependency of apps/web, not of the repo root, so
// the bare specifier would not resolve to the module billing.js imports.
vi.mock("../packages/payments/src/index.js", async (importOriginal) => ({
    ...(await importOriginal()),
    createCheckout: (...a) => createCheckout(...a)
}));
vi.mock("@/lib/data/interactive-billing", () => ({ userIdForCoinpaySubject: async (sub) => state.subjects[sub] ?? null }));
vi.mock("@/lib/data/api-keys", () => ({ billingCaller: async () => state.caller }));

process.env.INFERNET_TRUSTED_CLIENT_KEYS = `c0mpute:${createHash("sha256").update(TRUSTED_KEY).digest("hex")}`;
delete process.env.TOPUP_RETURN_ORIGINS;

const { POST } = await import("@/app/api/v1/billing/topup/route");
const { GET } = await import("@/app/api/v1/billing/topup/[id]/route");

let ipSeq = 0;
function post(body, headers = {}) {
    return new Request("https://infernetprotocol.com/api/v1/billing/topup", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
}
const trustedHeaders = (sub = SUB) => ({
    authorization: `Bearer ${TRUSTED_KEY}`,
    ...(sub === null ? {} : { "x-infernet-billed-subject": sub })
});
function get(id, headers = {}) {
    return GET(new Request(`https://infernetprotocol.com/api/v1/billing/topup/${id}`, { headers }), { params: Promise.resolve({ id }) });
}
const topups = () => fake.db.tables.billing_topups;

beforeEach(() => {
    fake = createFakeSupabase({ tables: { settings: [], billing_topups: [] } });
    state.subjects = { [SUB]: LINKED_USER };
    state.caller = null;
    state.authEmails = { [LINKED_USER]: PLACEHOLDER };
    createCheckout.mockReset();
    createCheckout.mockImplementation(async ({ orderId }) => ({ id: `cs_${orderId}`, paymentUrl: `https://pay.example/${orderId}` }));
    delete process.env.TOPUP_RETURN_ORIGINS;
});

describe("return URL allowlist", () => {
    it("defaults to c0mpute.com when the env is unset or blank", () => {
        expect(DEFAULT_TOPUP_RETURN_ORIGINS).toEqual(["https://c0mpute.com"]);
        expect([...topupReturnOrigins(undefined)]).toEqual(["https://c0mpute.com"]);
        expect([...topupReturnOrigins(" , ")]).toEqual(["https://c0mpute.com"]);
    });

    it("reads comma-separated origins and drops what is not an https origin", () => {
        const set = topupReturnOrigins("https://a.example, https://b.example:8443/path ,http://plain.example,junk,https://user:pw@c.example");
        expect([...set]).toEqual(["https://a.example", "https://b.example:8443"]);
    });

    it("accepts only an absolute https URL on an allowed origin, compared exactly", () => {
        const origins = topupReturnOrigins(undefined);
        expect(isAllowedReturnUrl("https://c0mpute.com/checkout/done?topup=1#ok", origins)).toBe(true);
        expect(isAllowedReturnUrl("https://c0mpute.com", origins)).toBe(true);
        for (const bad of [
            "http://c0mpute.com/checkout",              // not https
            "https://c0mpute.com.evil.example/x",       // suffix of the host
            "https://evilc0mpute.com/x",                // prefix of the host
            "https://www.c0mpute.com/x",                // a different origin
            "https://c0mpute.com:8443/x",               // a different port
            "https://c0mpute.com@evil.example/x",       // allowed host as the username
            "https://user:pw@c0mpute.com/x",            // credentials
            "https://evil.example/?next=https://c0mpute.com",
            "//c0mpute.com/x",                          // not absolute
            "/checkout/done",
            "javascript:alert(1)",
            "https://c0mpute.com\\@evil.example/x",
            " https://c0mpute.com/x",
            "",
            "not a url",
            `https://c0mpute.com/${"a".repeat(2100)}`
        ]) {
            expect(isAllowedReturnUrl(bad, origins), bad).toBe(false);
        }
        for (const bad of [42, {}, ["https://c0mpute.com/x"], true]) expect(isAllowedReturnUrl(bad, origins)).toBe(false);
    });

    it("treats absent as fine and names the field that is refused", () => {
        const origins = topupReturnOrigins(undefined);
        expect(parseReturnUrls({}, origins)).toEqual({ ok: true });
        expect(parseReturnUrls({ success_url: null, cancel_url: undefined }, origins)).toEqual({ ok: true });
        expect(parseReturnUrls({ success_url: "https://c0mpute.com/a", cancel_url: "https://c0mpute.com/b" }, origins))
            .toEqual({ ok: true, successUrl: "https://c0mpute.com/a", cancelUrl: "https://c0mpute.com/b" });
        expect(parseReturnUrls({ success_url: "https://c0mpute.com/a", cancel_url: "https://evil.example/b" }, origins))
            .toEqual({ ok: false, field: "cancel_url" });
        expect(parseReturnUrls({ success_url: "" }, origins)).toEqual({ ok: false, field: "success_url" });
    });
});

describe("POST /api/v1/billing/topup as a trusted client", () => {
    it("opens the top-up for the account the subject is bound to and passes the return URLs on", async () => {
        const res = await POST(post(
            { amount_usd: "25.00", success_url: "https://c0mpute.com/checkout/done", cancel_url: "https://c0mpute.com/checkout" },
            trustedHeaders()
        ));
        expect(res.status).toBe(201);
        const { data } = await res.json();

        expect(topups()).toHaveLength(1);
        expect(topups()[0]).toMatchObject({ user_id: LINKED_USER, user_email: null, amount_usd: "25.00", amount_micro: 25_000_000 });
        expect(data.topup).toMatchObject({ id: topups()[0].id, amount_usd: "25.00" });
        expect(data.checkout_url).toBe(`https://pay.example/${topups()[0].id}`);
        expect(data.next).toContain(`/api/v1/billing/topup/${topups()[0].id}`);

        expect(createCheckout).toHaveBeenCalledTimes(1);
        const sent = createCheckout.mock.calls[0][0];
        expect(sent).toMatchObject({
            amountUsd: 25,
            orderId: topups()[0].id,
            accountId: LINKED_USER,
            metadata: { billing_topup_id: topups()[0].id },
            successUrl: "https://c0mpute.com/checkout/done",
            cancelUrl: "https://c0mpute.com/checkout",
            idempotencyKey: `topup:${topups()[0].id}`
        });
        // The placeholder auth email of a CoinPay-created account is no
        // address: CoinPay gets the per-account fallback instead.
        expect(sent.email).toBeUndefined();
    });

    it("uses the account's own email when it has a real one", async () => {
        state.authEmails[LINKED_USER] = "person@example.com";
        const res = await POST(post({ amount_usd: 5 }, trustedHeaders()));
        expect(res.status).toBe(201);
        expect(topups()[0].user_email).toBe("person@example.com");
        expect(createCheckout.mock.calls[0][0].email).toBe("person@example.com");
    });

    it("falls back to the docs return URLs when none are sent", async () => {
        const res = await POST(post({ amount_usd: 5 }, trustedHeaders()));
        expect(res.status).toBe(201);
        const sent = createCheckout.mock.calls[0][0];
        expect(sent.successUrl).toMatch(/\/docs\/batch-inference#topup$/);
        expect(sent.cancelUrl).toMatch(/\/docs\/batch-inference$/);
    });

    it("400 missing_subject when the trusted key names nobody", async () => {
        for (const headers of [trustedHeaders(null), trustedHeaders("   ")]) {
            const res = await POST(post({ amount_usd: 5 }, headers));
            expect(res.status).toBe(400);
            expect((await res.json()).error).toBe("missing_subject");
        }
        expect(topups()).toHaveLength(0);
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("never falls through to the signed-in caller when the trusted key names nobody", async () => {
        state.caller = { id: OTHER_USER, email: "other@example.com" };
        const res = await POST(post({ amount_usd: 5 }, trustedHeaders(null)));
        expect(res.status).toBe(400);
        expect(topups()).toHaveLength(0);
    });

    it("404 subject_not_linked for a subject with no Infernet account", async () => {
        const res = await POST(post({ amount_usd: 5 }, trustedHeaders("cp-nobody")));
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe("subject_not_linked");
        expect(topups()).toHaveLength(0);
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("400 return_url_not_allowed for a disallowed, malformed or non-https return URL, before anything is created", async () => {
        const cases = [
            { success_url: "https://evil.example/done" },
            { cancel_url: "https://c0mpute.com.evil.example/x" },
            { success_url: "http://c0mpute.com/done" },
            { success_url: "https://user:pw@c0mpute.com/done" },
            { cancel_url: "not a url" },
            { success_url: "/checkout/done" },
            { success_url: "" },
            { success_url: 42 },
            { success_url: "https://c0mpute.com/ok", cancel_url: "https://evil.example/x" }
        ];
        for (const extra of cases) {
            state.subjects[`sub-${cases.indexOf(extra)}`] = `33333333-3333-4333-8333-00000000000${cases.indexOf(extra)}`;
            const res = await POST(post({ amount_usd: 5, ...extra }, trustedHeaders(`sub-${cases.indexOf(extra)}`)));
            expect(res.status, JSON.stringify(extra)).toBe(400);
            const json = await res.json();
            expect(json.error).toBe("return_url_not_allowed");
            expect(["success_url", "cancel_url"]).toContain(json.field);
        }
        expect(topups()).toHaveLength(0);
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("honours TOPUP_RETURN_ORIGINS, which replaces the default", async () => {
        process.env.TOPUP_RETURN_ORIGINS = "https://staging.c0mpute.example";
        state.subjects.a = "44444444-4444-4444-8444-444444444441";
        state.subjects.b = "44444444-4444-4444-8444-444444444442";
        const yes = await POST(post({ amount_usd: 5, success_url: "https://staging.c0mpute.example/done" }, trustedHeaders("a")));
        expect(yes.status).toBe(201);
        const no = await POST(post({ amount_usd: 5, success_url: "https://c0mpute.com/done" }, trustedHeaders("b")));
        expect(no.status).toBe(400);
        expect((await no.json()).error).toBe("return_url_not_allowed");
    });

    it("keeps the ordinary amount validation", async () => {
        const res = await POST(post({ amount_usd: "0.01" }, trustedHeaders()));
        expect(res.status).toBe(400);
        expect(topups()).toHaveLength(0);
        const bad = await POST(post("{not json", trustedHeaders()));
        expect(bad.status).toBe(400);
    });

    it("limits by account alone: the client's server IP does not split the budget", async () => {
        state.subjects.busy = "55555555-5555-4555-8555-555555555555";
        const statuses = [];
        for (let i = 0; i < 11; i += 1) {
            const res = await POST(post({ amount_usd: 5 }, { ...trustedHeaders("busy"), "x-forwarded-for": `10.0.0.${i}` }));
            statuses.push(res.status);
        }
        expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
        expect(statuses[10]).toBe(429);
    });
});

describe("a bearer that is not a registered trusted key gains nothing from the subject header", () => {
    it("401s an unregistered ifc_ key naming a linked subject", async () => {
        const res = await POST(post(
            { amount_usd: 5, success_url: "https://c0mpute.com/done" },
            { authorization: `Bearer ${UNREGISTERED_KEY}`, "x-infernet-billed-subject": SUB }
        ));
        expect(res.status).toBe(401);
        expect(topups()).toHaveLength(0);
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it("401s no bearer at all naming a linked subject", async () => {
        const res = await POST(post({ amount_usd: 5 }, { "x-infernet-billed-subject": SUB }));
        expect(res.status).toBe(401);
        expect(topups()).toHaveLength(0);
    });

    it("an ordinary caller naming someone else's subject tops up only their own account", async () => {
        state.caller = { id: OTHER_USER, email: "other@example.com", via: "api_key" };
        const res = await POST(post(
            { amount_usd: 5 },
            { authorization: "Bearer ik_live_" + "a".repeat(43), "x-infernet-billed-subject": SUB, "x-forwarded-for": `192.0.2.${++ipSeq}` }
        ));
        expect(res.status).toBe(201);
        expect(topups()).toHaveLength(1);
        expect(topups()[0].user_id).toBe(OTHER_USER);
    });
});

describe("POST /api/v1/billing/topup as an ordinary caller is unchanged", () => {
    it("opens the top-up for the caller and ignores success_url / cancel_url, allowlisted or not", async () => {
        state.caller = { id: OTHER_USER, email: "other@example.com", via: "api_key" };
        const res = await POST(post(
            { amount_usd: "5.00", success_url: "https://c0mpute.com/checkout/done", cancel_url: "https://evil.example/x" },
            { authorization: "Bearer ik_live_" + "a".repeat(43), "x-forwarded-for": `192.0.2.${++ipSeq}` }
        ));
        expect(res.status).toBe(201);
        const { data } = await res.json();
        const row = topups()[0];
        expect(row).toMatchObject({ user_id: OTHER_USER, user_email: "other@example.com", amount_usd: "5.00" });
        expect(Object.keys(data).sort()).toEqual(["checkout_url", "next", "topup"]);

        // Exactly the arguments the checkout got before this change.
        const sent = createCheckout.mock.calls[0][0];
        expect(Object.keys(sent).sort()).toEqual(
            ["amountUsd", "cancelUrl", "description", "email", "idempotencyKey", "metadata", "orderId", "successUrl"]
        );
        expect(sent).toMatchObject({
            amountUsd: 5,
            orderId: row.id,
            description: "Infernet compute balance top-up: $5.00",
            email: "other@example.com",
            metadata: { billing_topup_id: row.id },
            idempotencyKey: `topup:${row.id}`
        });
        expect(sent.successUrl).toMatch(/\/docs\/batch-inference#topup$/);
        expect(sent.cancelUrl).toMatch(/\/docs\/batch-inference$/);
        expect(sent.successUrl).not.toContain("c0mpute.com");
    });

    it("still 401s an anonymous caller", async () => {
        const res = await POST(post({ amount_usd: 5 }));
        expect(res.status).toBe(401);
    });
});

describe("GET /api/v1/billing/topup/:id as a trusted client", () => {
    const MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const THEIRS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    beforeEach(() => {
        topups().push(
            { id: MINE, user_id: LINKED_USER, status: "paid", amount_usd: "25.00", created_at: "2026-11-22T00:00:00Z", paid_at: "2026-11-22T00:05:00Z" },
            { id: THEIRS, user_id: OTHER_USER, status: "paid", amount_usd: "9.00", created_at: "2026-11-22T00:00:00Z", paid_at: "2026-11-22T00:05:00Z" }
        );
    });

    it("reads a top-up of the person it names", async () => {
        const res = await get(MINE, trustedHeaders());
        expect(res.status).toBe(200);
        expect((await res.json()).data).toMatchObject({ id: MINE, status: "paid", amount_usd: "25.00" });
    });

    it("404s a top-up that belongs to another account", async () => {
        const res = await get(THEIRS, trustedHeaders());
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe("top-up not found");
    });

    it("400s without a subject and 404s an unlinked one, without reading the top-up", async () => {
        const none = await get(MINE, trustedHeaders(null));
        expect(none.status).toBe(400);
        expect((await none.json()).error).toBe("missing_subject");
        const unlinked = await get(MINE, trustedHeaders("cp-nobody"));
        expect(unlinked.status).toBe(404);
        expect((await unlinked.json()).error).toBe("subject_not_linked");
    });

    it("401s an unregistered key naming the owner's subject", async () => {
        const res = await get(MINE, { authorization: `Bearer ${UNREGISTERED_KEY}`, "x-infernet-billed-subject": SUB });
        expect(res.status).toBe(401);
    });

    it("is unchanged for an ordinary caller: own top-up only, the subject header ignored", async () => {
        state.caller = { id: OTHER_USER, email: "other@example.com", via: "api_key" };
        const headers = { authorization: "Bearer ik_live_" + "a".repeat(43), "x-infernet-billed-subject": SUB };
        expect((await get(THEIRS, headers)).status).toBe(200);
        expect((await get(MINE, headers)).status).toBe(404);
    });
});
