import { describe, it, expect } from "vitest";
import {
    DEFAULT_OPERATOR_FREE_QUERIES_PER_DAY,
    DEFAULT_OPERATOR_FREE_SONGS_PER_DAY,
    RUN_A_NODE_URL,
    resolveOperatorAllowance,
    pickFreeLimit,
    createOperatorCache,
    operatorSongLimit,
    musicSubject,
    freeSubject,
    freeLimitMessage,
    songLimitMessage
} from "../apps/web/lib/billing/free-tier.js";

/**
 * Node operators get a bigger free allowance (Anthony, 2026-11-09). Whether
 * someone qualifies is operator_qualifies() in Postgres; this is the part that
 * picks the number, words the 429, and caches the answer.
 */

describe("the operator allowance", () => {
    it("is 100 queries and 5 songs a day by default", () => {
        expect(DEFAULT_OPERATOR_FREE_QUERIES_PER_DAY).toBe(100);
        expect(DEFAULT_OPERATOR_FREE_SONGS_PER_DAY).toBe(5);
        expect(resolveOperatorAllowance()).toEqual({ queries: 100, songs: 5 });
        expect(resolveOperatorAllowance({ settings: { free_queries_per_day: 3 } })).toEqual({ queries: 100, songs: 5 });
    });

    it("reads both numbers from the interactive_billing settings row", () => {
        expect(resolveOperatorAllowance({
            settings: { operator_free_queries_per_day: 250, operator_free_songs_per_day: 2 }
        })).toEqual({ queries: 250, songs: 2 });
    });

    it("falls back to the defaults on junk rather than going unlimited", () => {
        for (const bad of ["abc", "", null, -1, 1.5, {}]) {
            expect(resolveOperatorAllowance({
                settings: { operator_free_queries_per_day: bad, operator_free_songs_per_day: bad }
            })).toEqual({ queries: 100, songs: 5 });
        }
        expect(resolveOperatorAllowance({ settings: [] })).toEqual({ queries: 100, songs: 5 });
    });
});

describe("picking the limit", () => {
    it("uses the normal limit for anyone who does not qualify", () => {
        expect(pickFreeLimit({ base: 10, operatorLimit: 100, qualifies: false })).toBe(10);
        expect(pickFreeLimit({ base: 10, operatorLimit: 100 })).toBe(10);
    });

    it("uses the operator limit for a qualifying operator", () => {
        expect(pickFreeLimit({ base: 10, operatorLimit: 100, qualifies: true })).toBe(100);
    });

    it("never leaves an operator below a stranger", () => {
        expect(pickFreeLimit({ base: 10, operatorLimit: 4, qualifies: true })).toBe(10);
        expect(pickFreeLimit({ base: 10, operatorLimit: null, qualifies: true })).toBe(10);
    });

    it("keeps the same counter key for an operator: only the ceiling moves", () => {
        expect(freeSubject({ userId: "u1" })).toBe("user:u1");
        expect(musicSubject("u1")).toBe("music:user:u1");
        expect(musicSubject(null)).toBe(null);
        expect(musicSubject("")).toBe(null);
    });

    it("caps operator songs at the setting, but never below a stranger's free queries", () => {
        expect(operatorSongLimit({ songs: 5, base: 3 })).toBe(5);
        expect(operatorSongLimit({ songs: 5, base: 10 })).toBe(10);
        expect(operatorSongLimit({ songs: 20, base: 10 })).toBe(20);
        expect(operatorSongLimit({ songs: undefined, base: 0 })).toBe(5);
    });
});

describe("the 429 message", () => {
    it("points someone who is not an operator at running a node", () => {
        const m = freeLimitMessage(10);
        expect(m).toContain("10 queries a day");
        expect(m).toMatch(/top up/i);
        expect(m).toContain("run an Infernet node to get 100 free queries a day");
        expect(m).toContain(RUN_A_NODE_URL);
        expect(RUN_A_NODE_URL).toBe("https://infernetprotocol.com/getting-started#operate");
    });

    it("takes the consumeFreeQuery result as options", () => {
        expect(freeLimitMessage(10, { operator: false, operatorLimit: 250 })).toContain("250 free queries a day");
    });

    it("does not tell an operator to become one", () => {
        const m = freeLimitMessage(100, { operator: true, operatorLimit: 100 });
        expect(m).toContain("100 queries a day");
        expect(m).not.toContain(RUN_A_NODE_URL);
    });

    it("says nothing about nodes when running one would not raise the limit", () => {
        expect(freeLimitMessage(100, { operator: false, operatorLimit: 100 })).not.toContain(RUN_A_NODE_URL);
    });

    it("words the operator song cap", () => {
        expect(songLimitMessage(5)).toContain("5 songs a day for node operators");
        expect(songLimitMessage(1)).toContain("1 song a day");
    });
});

describe("the operator cache", () => {
    function setup(answer) {
        let t = 0;
        const calls = [];
        const qualifies = createOperatorCache({
            check: async (userId) => {
                calls.push(userId);
                return typeof answer === "function" ? answer(userId) : answer;
            },
            ttlMs: 1000,
            now: () => t
        });
        return { qualifies, calls, advance: (ms) => { t += ms; } };
    }

    it("asks once per user per TTL", async () => {
        const { qualifies, calls, advance } = setup(true);
        expect(await qualifies("u1")).toBe(true);
        expect(await qualifies("u1")).toBe(true);
        expect(calls).toEqual(["u1"]);
        advance(999);
        await qualifies("u1");
        expect(calls).toEqual(["u1"]);
        advance(1);
        await qualifies("u1");
        expect(calls).toEqual(["u1", "u1"]);
    });

    it("caches a no as well as a yes, per user", async () => {
        const { qualifies, calls } = setup((u) => u === "op");
        expect(await qualifies("op")).toBe(true);
        expect(await qualifies("stranger")).toBe(false);
        expect(await qualifies("stranger")).toBe(false);
        expect(calls).toEqual(["op", "stranger"]);
    });

    it("never asks for a caller with no account", async () => {
        const { qualifies, calls } = setup(true);
        expect(await qualifies(null)).toBe(false);
        expect(await qualifies("")).toBe(false);
        expect(calls).toEqual([]);
    });

    it("reads a failure as not an operator, and does not cache it", async () => {
        let fail = true;
        const { qualifies, calls } = setup(() => {
            if (fail) throw new Error("db down");
            return true;
        });
        expect(await qualifies("u1")).toBe(false);
        fail = false;
        expect(await qualifies("u1")).toBe(true);
        expect(calls).toEqual(["u1", "u1"]);
    });

    it("reads a non-boolean answer as not an operator", async () => {
        const { qualifies } = setup(null);
        expect(await qualifies("u1")).toBe(false);
    });
});
