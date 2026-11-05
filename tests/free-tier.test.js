import { describe, it, expect } from "vitest";
import {
    DEFAULT_FREE_QUERIES_PER_DAY,
    DEFAULT_BOT_THRESHOLD,
    resolveFreeAllowance,
    freeSubject,
    looksLikeBot,
    freeLimitMessage,
    secondsUntilReset
} from "../apps/web/lib/billing/free-tier.js";

/**
 * The free daily allowance (Anthony, 2026-11-05: "make free queries limited to
 * ten per day"). The counter itself is in Postgres; this is the part that
 * decides the number and whose allowance is being spent.
 */

describe("the allowance", () => {
    it("is ten a day by default", () => {
        expect(DEFAULT_FREE_QUERIES_PER_DAY).toBe(10);
        expect(resolveFreeAllowance({ env: {} })).toBe(10);
    });

    it("can be changed by env and by the settings row", () => {
        expect(resolveFreeAllowance({ env: { INFERNET_FREE_QUERIES_PER_DAY: "25" } })).toBe(25);
        expect(resolveFreeAllowance({ env: {}, settings: { free_queries_per_day: 3 } })).toBe(3);
        // Settings wins over env, same as the rest of the billing config.
        expect(resolveFreeAllowance({ env: { INFERNET_FREE_QUERIES_PER_DAY: "25" }, settings: { free_queries_per_day: 3 } })).toBe(3);
    });

    it("can be set to zero, which is no free queries at all", () => {
        expect(resolveFreeAllowance({ env: {}, settings: { free_queries_per_day: 0 } })).toBe(0);
    });

    it("falls back rather than becoming unlimited on a bad value", () => {
        // The failure that matters here is giving compute away, so junk must
        // not read as "no cap".
        for (const bad of ["abc", "", null, -5, 1.5, {}]) {
            expect(resolveFreeAllowance({ env: {}, settings: { free_queries_per_day: bad } })).toBe(10);
        }
    });
});

describe("whose allowance is being spent", () => {
    // visitorKey / ipKey are keyed hashes handed over by
    // @profullstack/browser-fingerprint; nothing is hashed in this module now.
    it("keys a signed-in caller on their account, above everything else", () => {
        expect(freeSubject({ userId: "u1", visitorKey: "vk", ipKey: "ik" })).toBe("user:u1");
        // The same person from another device or network spends one allowance.
        expect(freeSubject({ userId: "u1", visitorKey: "other", ipKey: "other" })).toBe("user:u1");
    });

    it("gives two people behind one address their own allowance", () => {
        expect(freeSubject({ userId: "u1", ipKey: "same" })).not.toBe(freeSubject({ userId: "u2", ipKey: "same" }));
    });

    it("keys an unlinked trusted-client person on the subject, not the client's IP", () => {
        // Otherwise every c0mpute.com user without an account here would share
        // ONE allowance, because they all arrive from the same server.
        const a = freeSubject({ clientSubject: "hash-a", ipKey: "client-server" });
        const b = freeSubject({ clientSubject: "hash-b", ipKey: "client-server" });
        expect(a).not.toBe(b);
        expect(a.startsWith("sub:")).toBe(true);
    });

    it("prefers a real account over the client's claim", () => {
        expect(freeSubject({ userId: "u1", clientSubject: "hash-a" })).toBe("user:u1");
    });

    it("keys an anonymous BROWSER on the device, not the address", () => {
        // The whole reason for the module: two browsers behind one address get
        // one allowance each, and one browser that changes address keeps one.
        const a = freeSubject({ visitorKey: "device-a", ipKey: "shared" });
        const b = freeSubject({ visitorKey: "device-b", ipKey: "shared" });
        expect(a).toBe("visitor:device-a");
        expect(a).not.toBe(b);
        expect(freeSubject({ visitorKey: "device-a", ipKey: "elsewhere" })).toBe(a);
    });

    it("prefers the device over the address when it has both", () => {
        expect(freeSubject({ visitorKey: "vk", ipKey: "ik" })).toBe("visitor:vk");
    });

    it("falls back to the address key for a caller with no browser (CLI, curl)", () => {
        expect(freeSubject({ ipKey: "prefix-hash" })).toBe("ip:prefix-hash");
    });

    it("is null when there is nothing to key on", () => {
        expect(freeSubject({})).toBeNull();
        expect(freeSubject({ userId: "", clientSubject: "", visitorKey: "", ipKey: "" })).toBeNull();
    });
});

describe("the bot gate", () => {
    it("only refuses a confident signal", () => {
        expect(DEFAULT_BOT_THRESHOLD).toBe(0.9);
        expect(looksLikeBot({ score: 0.95 })).toBe(true);
        expect(looksLikeBot({ score: 0.9 })).toBe(true);
        expect(looksLikeBot({ score: 0.89 })).toBe(false);
        expect(looksLikeBot({ score: 0.5 })).toBe(false);
    });

    it("never refuses when there is no score", () => {
        // A false positive costs a real person their free tier, which is worse
        // than serving a bot ten queries.
        expect(looksLikeBot(null)).toBe(false);
        expect(looksLikeBot(undefined)).toBe(false);
        expect(looksLikeBot({})).toBe(false);
        expect(looksLikeBot({ score: "high" })).toBe(false);
    });
});

describe("the refusal", () => {
    it("says the number and what to do instead", () => {
        const m = freeLimitMessage(10);
        expect(m).toContain("10 queries a day");
        expect(m).toMatch(/top up/i);
        expect(m).toMatch(/earned/i);
    });

    it("reads correctly at one", () => {
        expect(freeLimitMessage(1)).toContain("1 query a day");
    });

    it("resets at the next UTC midnight", () => {
        const noon = new Date("2026-11-05T12:00:00Z");
        expect(secondsUntilReset(noon)).toBe(12 * 3600);
        const nearly = new Date("2026-11-05T23:59:30Z");
        expect(secondsUntilReset(nearly)).toBe(30);
        // Never zero or negative, so a Retry-After is always usable.
        expect(secondsUntilReset(new Date("2026-11-05T23:59:59.999Z"))).toBeGreaterThan(0);
    });
});
