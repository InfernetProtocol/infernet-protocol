import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "./fixtures/fake-supabase.js";

/**
 * Signed billed subjects (2026-11-22). c0mpute.com users with no CoinPay
 * identity reached us as c0mpute's server address and shared ONE ten a day
 * free allowance. c0mpute now names each of them as `c0mpute:<user id>`,
 * signed with a secret only it holds; we meter each such person separately,
 * ignore anything unsigned, stale or forged (address metering, as before),
 * and cap the whole origin per day in case the secret leaks.
 */

const SECRET = "s".repeat(48);
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);

vi.mock("server-only", () => ({}));
let fake;
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fake }));
vi.mock("@/lib/data/api-keys", () => ({ billingCaller: async () => null }));
vi.mock("@/lib/data/fingerprint", () => ({
    identifyVisitor: async ({ ip }) => ({ ok: false, visitorKey: null, ipKey: ip ? `k-${ip}` : null, bot: null })
}));

const {
    subjectSignature,
    verifySignedSubject,
    signedSubjectOrigin,
    originFreeCeiling,
    DEFAULT_ORIGIN_FREE_CEILING
} = await import("@/lib/billing/signed-subject");
const { billedSubjectFrom } = await import("@/lib/trusted-clients");
const { resolveBillingCaller } = await import("@/lib/data/interactive-billing");
const { consumeFreeQuery } = await import("@/lib/data/free-tier");
const { freeLimitMessage } = await import("@/lib/billing/free-tier");

const C0MPUTE = { name: "c0mpute-chat", hash: "h" };
const OTHER_CLIENT = { name: "outreachgraph", hash: "h2" };

function signedHeaders(subject, { ts = Math.floor(Date.now() / 1000), rid = "req_0123456789", secret = SECRET } = {}) {
    return {
        "x-infernet-billed-subject": subject,
        "x-infernet-subject-ts": String(ts),
        "x-infernet-request-id": rid,
        "x-infernet-subject-sig": subjectSignature(secret, subject, String(ts), rid)
    };
}

const req = (headers) => new Request("https://infernetprotocol.com/v1/chat/completions", { method: "POST", headers });

/** A free_query_consume that behaves like the SQL one (per subject+day counter). */
function ledger() {
    const counts = new Map();
    return createFakeSupabase({
        tables: { settings: [], free_queries: [] },
        rpc: {
            free_query_consume: ({ p_subject, p_max }) => {
                const used = (counts.get(p_subject) ?? 0) + 1;
                if (used > p_max) {
                    counts.set(p_subject, p_max);
                    return { allowed: false, used: p_max, remaining: 0, limit: p_max };
                }
                counts.set(p_subject, used);
                return { allowed: true, used, remaining: p_max - used, limit: p_max };
            }
        }
    });
}

beforeEach(() => {
    process.env.C0MPUTE_INFERNET_SUBJECT_SECRET = SECRET;
    delete process.env.C0MPUTE_INFERNET_FREE_CEILING;
    delete process.env.C0MPUTE_INFERNET_SUBJECT_CLIENTS;
    fake = ledger();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    delete process.env.C0MPUTE_INFERNET_SUBJECT_SECRET;
    vi.restoreAllMocks();
});

describe("verifySignedSubject", () => {
    const base = (over = {}) => {
        const subject = "c0mpute:user_1";
        const ts = String(Math.floor(NOW / 1000));
        const requestId = "req_abcdefgh";
        return {
            subject,
            ts,
            requestId,
            sig: subjectSignature(SECRET, subject, ts, requestId),
            trustedName: "c0mpute-chat",
            env: { C0MPUTE_INFERNET_SUBJECT_SECRET: SECRET },
            now: NOW,
            ...over
        };
    };

    it("accepts a good signature from c0mpute's key", () => {
        expect(verifySignedSubject(base())).toEqual({ ok: true, origin: "c0mpute" });
    });

    it("refuses a forged, stale or incomplete one", () => {
        expect(verifySignedSubject(base({ sig: "0".repeat(64) })).reason).toBe("bad_sig");
        expect(verifySignedSubject(base({ subject: "c0mpute:user_2" })).reason).toBe("bad_sig");
        expect(verifySignedSubject(base({ now: NOW + 5 * 60 * 1000 + 1000 })).reason).toBe("stale");
        expect(verifySignedSubject(base({ now: NOW - 6 * 60 * 1000 })).reason).toBe("stale");
        expect(verifySignedSubject(base({ ts: null })).reason).toBe("bad_ts");
        expect(verifySignedSubject(base({ requestId: "x" })).reason).toBe("bad_request_id");
        expect(verifySignedSubject(base({ sig: null })).reason).toBe("bad_sig");
    });

    it("accepts it only on one of the origin's trusted keys", () => {
        expect(verifySignedSubject(base({ trustedName: "outreachgraph" })).reason).toBe("wrong_client");
        expect(verifySignedSubject(base({
            trustedName: "outreachgraph",
            env: { C0MPUTE_INFERNET_SUBJECT_SECRET: SECRET, C0MPUTE_INFERNET_SUBJECT_CLIENTS: "outreachgraph" }
        })).ok).toBe(true);
    });

    it("never accepts anything without a real secret configured", () => {
        expect(verifySignedSubject(base({ env: {} })).reason).toBe("not_configured");
        expect(verifySignedSubject(base({ env: { C0MPUTE_INFERNET_SUBJECT_SECRET: "short" } })).reason).toBe("not_configured");
    });

    it("only knows prefixed subjects", () => {
        expect(signedSubjectOrigin("c0mpute:abc")).toBe("c0mpute");
        expect(signedSubjectOrigin("cp-sub-1")).toBeNull();
        expect(signedSubjectOrigin("evil:abc")).toBeNull();
        expect(signedSubjectOrigin("c0mpute:a b")).toBeNull();
    });

    it("caps an origin at 5,000 a day unless configured", () => {
        expect(DEFAULT_ORIGIN_FREE_CEILING).toBe(5000);
        expect(originFreeCeiling("c0mpute", {})).toBe(5000);
        expect(originFreeCeiling("c0mpute", { C0MPUTE_INFERNET_FREE_CEILING: "7" })).toBe(7);
        expect(originFreeCeiling("c0mpute", { C0MPUTE_INFERNET_FREE_CEILING: "junk" })).toBe(5000);
    });
});

describe("billedSubjectFrom", () => {
    it("takes a signed c0mpute subject from c0mpute's key", () => {
        expect(billedSubjectFrom(req(signedHeaders("c0mpute:u1")), C0MPUTE)).toBe("c0mpute:u1");
    });

    it("drops an unsigned, forged or stale one (the caller falls back to the address)", () => {
        expect(billedSubjectFrom(req({ "x-infernet-billed-subject": "c0mpute:u1" }), C0MPUTE)).toBeNull();
        expect(billedSubjectFrom(req(signedHeaders("c0mpute:u1", { secret: "x".repeat(48) })), C0MPUTE)).toBeNull();
        expect(billedSubjectFrom(req(signedHeaders("c0mpute:u1", { ts: Math.floor(Date.now() / 1000) - 3600 })), C0MPUTE)).toBeNull();
        expect(billedSubjectFrom(req(signedHeaders("c0mpute:u1")), OTHER_CLIENT)).toBeNull();
        expect(billedSubjectFrom(req(signedHeaders("c0mpute:u1")), null)).toBeNull();
    });

    it("leaves CoinPay subjects as they were", () => {
        expect(billedSubjectFrom(req({ "x-infernet-billed-subject": "cp-sub-1" }), OTHER_CLIENT)).toBe("cp-sub-1");
    });
});

describe("metering", () => {
    async function spend(headers, ip = "203.0.113.7") {
        const payer = await resolveBillingCaller(req(headers), { trusted: C0MPUTE });
        return { payer, free: await consumeFreeQuery({ userId: payer.userId, clientSubject: payer.subject ?? null, ip, supabase: fake }) };
    }

    it("gives two signed subjects from the same IP separate allowances", async () => {
        for (let i = 0; i < 10; i += 1) expect((await spend(signedHeaders("c0mpute:alice"))).free.ok).toBe(true);
        const alice = await spend(signedHeaders("c0mpute:alice"));
        expect(alice.free.ok).toBe(false);
        expect(alice.free.subject).toBe("sub:c0mpute:alice");

        const bob = await spend(signedHeaders("c0mpute:bob"));
        expect(bob.payer.via).toBe("trusted_signed:c0mpute-chat");
        expect(bob.free).toMatchObject({ ok: true, used: 1, subject: "sub:c0mpute:bob", origin: "c0mpute", originUsed: 11 });
        // Per-subject metering is visible in the logs.
        expect(console.info).toHaveBeenCalledWith(expect.stringContaining("metered sub:c0mpute:bob allowed 1/10"));
    });

    it("meters a bad signature, a stale one or none at all by address", async () => {
        const forged = await spend({ ...signedHeaders("c0mpute:carol"), "x-infernet-subject-sig": "f".repeat(64) });
        expect(forged.payer).toEqual({ userId: null, via: "anonymous" });
        expect(forged.free.subject).toBe("ip:k-203.0.113.7");

        const stale = await spend(signedHeaders("c0mpute:carol", { ts: Math.floor(Date.now() / 1000) - 600 }));
        expect(stale.free.subject).toBe("ip:k-203.0.113.7");

        const bare = await spend({ "x-infernet-billed-subject": "c0mpute:carol" });
        expect(bare.free.subject).toBe("ip:k-203.0.113.7");
        expect(bare.free.used).toBe(3);
    });

    it("enforces the per-origin daily ceiling across subjects", async () => {
        process.env.C0MPUTE_INFERNET_FREE_CEILING = "3";
        for (const who of ["a", "b", "c"]) expect((await spend(signedHeaders(`c0mpute:${who}`))).free.ok).toBe(true);
        const d = await spend(signedHeaders("c0mpute:d"));
        expect(d.free).toMatchObject({ ok: false, reason: "origin_ceiling", originCeiling: 3 });
        expect(freeLimitMessage(d.free.limit, d.free)).toMatch(/this app's free queries for today are used up/);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("reached its free ceiling"));
        // Raising the ceiling lets the origin through again the same day.
        process.env.C0MPUTE_INFERNET_FREE_CEILING = "100";
        expect((await spend(signedHeaders("c0mpute:e"))).free.ok).toBe(true);
    });
});
