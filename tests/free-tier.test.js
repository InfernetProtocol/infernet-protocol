import { describe, it, expect } from "vitest";
import {
    DEFAULT_FREE_QUERIES_PER_DAY,
    resolveFreeAllowance,
    freeSubject,
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
    const salt = "test-salt";

    it("keys a signed-in caller on their account, not their address", () => {
        expect(freeSubject({ userId: "u1", ip: "1.2.3.4", salt })).toBe("user:u1");
        // Same person from a different network spends the same allowance.
        expect(freeSubject({ userId: "u1", ip: "9.9.9.9", salt })).toBe("user:u1");
    });

    it("gives two people behind one address their own allowance", () => {
        const a = freeSubject({ userId: "u1", ip: "1.2.3.4", salt });
        const b = freeSubject({ userId: "u2", ip: "1.2.3.4", salt });
        expect(a).not.toBe(b);
    });

    it("keys an unlinked trusted-client person on the subject, not the client's IP", () => {
        // Otherwise every c0mpute.com user without an account here would share
        // ONE allowance, because they all arrive from the same server.
        const a = freeSubject({ clientSubject: "cp-sub-a", ip: "10.0.0.1", salt });
        const b = freeSubject({ clientSubject: "cp-sub-b", ip: "10.0.0.1", salt });
        expect(a).not.toBe(b);
        expect(a.startsWith("sub:")).toBe(true);
    });

    it("prefers a real account over the client's claim", () => {
        expect(freeSubject({ userId: "u1", clientSubject: "cp-sub-a", salt })).toBe("user:u1");
    });

    it("falls back to the address for a true stranger", () => {
        const k = freeSubject({ ip: "1.2.3.4", salt });
        expect(k.startsWith("ip:")).toBe(true);
        expect(freeSubject({ ip: "1.2.3.5", salt })).not.toBe(k);
    });

    it("never puts a raw address in the key", () => {
        const k = freeSubject({ ip: "203.0.113.47", salt });
        expect(k).not.toContain("203.0.113.47");
        expect(k).toMatch(/^ip:[0-9a-f]{64}$/);
    });

    it("salts the hash, so the table cannot be walked back with a plain digest", () => {
        expect(freeSubject({ ip: "1.2.3.4", salt: "a" })).not.toBe(freeSubject({ ip: "1.2.3.4", salt: "b" }));
    });

    it("is stable for the same inputs", () => {
        expect(freeSubject({ ip: "1.2.3.4", salt })).toBe(freeSubject({ ip: "1.2.3.4", salt }));
    });

    it("is null when there is nothing to key on", () => {
        expect(freeSubject({})).toBeNull();
        expect(freeSubject({ userId: "", ip: "", clientSubject: "" })).toBeNull();
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
