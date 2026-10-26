import { describe, it, expect, beforeEach } from "vitest";
import { Credits, memoryStore as creditMemory } from "../apps/web/node_modules/@profullstack/redeem-credits/dist/index.js";
import { Affiliates, memoryStore as affMemory } from "../apps/web/node_modules/@profullstack/affiliates/dist/index.js";
import {
    redeemCreditCode,
    createInvite,
    acceptInvite,
    settleInviteBonus,
    onSignedIn,
    inviteOverview
} from "../apps/web/lib/credits/index.js";
import { CREDIT_UNIT, DAY_MS, DEFAULT_INVITE_BONUS_CREDITS } from "../apps/web/lib/credits/core.js";

/** Minimal fake of the supabase-js surface lib/credits uses. */
function fakeDb(users) {
    const bonuses = [];
    const query = (rows) => {
        let out = rows;
        const q = {
            select: () => q,
            in: (k, vals) => ((out = out.filter((r) => vals.includes(r[k]))), q),
            eq: (k, v) => ((out = out.filter((r) => r[k] === v)), q),
            gte: (k, v) => ((out = out.filter((r) => r[k] >= v)), q),
            then: (res) => res({ data: out, error: null })
        };
        return q;
    };
    return {
        bonuses,
        auth: {
            admin: {
                getUserById: async (id) => (users[id] ? { data: { user: users[id] }, error: null } : { data: null, error: { message: "nope" } })
            }
        },
        from: (table) => {
            if (table !== "invite_bonuses") throw new Error(`unexpected table ${table}`);
            return {
                select: () => query(bonuses),
                upsert: (row) => {
                    const dup = bonuses.some((b) => b.invite_id === row.invite_id && b.side === row.side);
                    if (!dup) bonuses.push({ ...row, created_at: new Date().toISOString() });
                    return { select: async () => ({ data: dup ? [] : [row], error: null }) };
                },
                delete: () => {
                    const conds = [];
                    const q = {
                        eq: (k, v) => (conds.push([k, v]), q),
                        then: (res) => {
                            for (let i = bonuses.length - 1; i >= 0; i--) if (conds.every(([k, v]) => bonuses[i][k] === v)) bonuses.splice(i, 1);
                            res({ error: null });
                        }
                    };
                    return q;
                }
            };
        }
    };
}

const now = Date.now();
const old = new Date(now - 30 * DAY_MS).toISOString();
const fresh = new Date(now - 60 * 1000).toISOString();

function setup(extraUsers = {}) {
    const users = {
        alice: { id: "alice", email: "alice@example.com", email_confirmed_at: old, created_at: old },
        bob: { id: "bob", email: "bob@example.org", email_confirmed_at: fresh, created_at: fresh },
        carl: { id: "carl", email: "carl@example.net", email_confirmed_at: null, created_at: fresh },
        dora: { id: "dora", email: "dora@example.net", email_confirmed_at: old, created_at: old },
        ...extraUsers
    };
    const db = fakeDb(users);
    const credits = new Credits(creditMemory());
    const affiliates = new Affiliates(affMemory(), { defaultQuota: 3, inviteTtlMs: 30 * DAY_MS });
    return { users, d: { db, credits, affiliates, now: () => Date.now() } };
}

describe("consumer credit codes", () => {
    it("redeems once into the consumer credits balance", async () => {
        const { d } = setup();
        const { code } = await d.credits.mint({ grant: { unit: CREDIT_UNIT, amount: 500 } });
        const r = await redeemCreditCode("alice", code, d);
        expect(r).toMatchObject({ ok: true, credits: 500, balance: 500 });
        const again = await redeemCreditCode("alice", code, d);
        expect(again).toMatchObject({ ok: false, reason: "already_redeemed" });
        const other = await redeemCreditCode("bob", code, d);
        expect(other).toMatchObject({ ok: false, reason: "used_up" });
        expect(await d.credits.balance("alice", CREDIT_UNIT)).toBe(500);
        expect((await redeemCreditCode("bob", "x", d)).reason).toBe("invalid");
    });
});

describe("invites", () => {
    let env;
    beforeEach(() => {
        env = setup();
    });

    it("a new confirmed account pays both sides once", async () => {
        const { d } = env;
        const inv = await createInvite("alice", "for bob", d);
        const r = await acceptInvite("bob", inv.code, d);
        expect(r).toMatchObject({ ok: true, bonus: "granted" });
        expect(await d.credits.balance("bob", CREDIT_UNIT)).toBe(DEFAULT_INVITE_BONUS_CREDITS);
        expect(await d.credits.balance("alice", CREDIT_UNIT)).toBe(DEFAULT_INVITE_BONUS_CREDITS);
        // settling again never pays twice
        expect((await settleInviteBonus("bob", d)).status).toBe("already");
        expect(await d.credits.balance("alice", CREDIT_UNIT)).toBe(DEFAULT_INVITE_BONUS_CREDITS);
        // one accepted invite per account
        const inv2 = await createInvite("dora", "", d);
        expect((await acceptInvite("bob", inv2.code, d)).reason).toBe("already_invited");
        const o = await inviteOverview("alice", d);
        expect(o.quota.left).toBe(2);
        expect(o.invites[0]).toMatchObject({ status: "used", bonus: "granted" });
    });

    it("waits for email confirmation, then pays on the next sign-in", async () => {
        const { d, users } = env;
        const inv = await createInvite("alice", "", d);
        const r = await onSignedIn("carl", { inviteCode: inv.code }, d);
        expect(r.invite).toMatchObject({ ok: true, bonus: "pending" });
        expect(await d.credits.balance("carl", CREDIT_UNIT)).toBe(0);
        users.carl.email_confirmed_at = new Date().toISOString();
        const s = await onSignedIn("carl", { inviteCode: inv.code }, d);
        expect(s.settled.status).toBe("granted");
        expect(await d.credits.balance("carl", CREDIT_UNIT)).toBe(DEFAULT_INVITE_BONUS_CREDITS);
    });

    it("refuses old accounts, too-new inviters and the same mailbox", async () => {
        const { d, users } = env;
        await expect(createInvite("bob", "", d)).rejects.toMatchObject({ reason: "too_new" });
        const inv = await createInvite("alice", "", d);
        expect((await acceptInvite("dora", inv.code, d)).reason).toBe("not_new");
        users.eve = { id: "eve", email: "Alice+alt@example.com", email_confirmed_at: fresh, created_at: fresh };
        const r = await acceptInvite("eve", inv.code, d);
        expect(r).toMatchObject({ ok: true, bonus: "denied" });
        expect(await d.credits.balance("eve", CREDIT_UNIT)).toBe(0);
        expect(await d.credits.balance("alice", CREDIT_UNIT)).toBe(0);
    });

    it("never writes provider earnings: only the consumer credits unit", async () => {
        const { d } = env;
        const inv = await createInvite("alice", "", d);
        await acceptInvite("bob", inv.code, d);
        const hist = await d.credits.history("alice");
        expect(hist.every((h) => h.unit === CREDIT_UNIT)).toBe(true);
    });
});
