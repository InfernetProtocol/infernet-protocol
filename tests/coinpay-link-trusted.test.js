import { describe, it, expect, afterEach } from "vitest";
import { resolveCoinpayUser } from "../apps/web/lib/auth/coinpay-signin.js";
import { trustedClientFor, hashKey } from "../apps/web/lib/trusted-clients.js";

/**
 * The trusted-client account link (POST /api/v1/coinpay/link-trusted).
 *
 * c0mpute.com verifies a person's CoinPay identity itself and then sends their
 * inference here under its own trusted key. Before this, billing could only
 * find them if they had ALSO signed in to infernetprotocol.com with the same
 * CoinPay account, which almost nobody had — so c0mpute's users were
 * unbillable. These cover the two things that must hold: only a trusted key
 * may assert a subject, and asserting one is idempotent.
 */

function memStore() {
    const identities = new Map(); // sub -> {user_id}
    const byUser = new Map();
    let n = 0;
    const created = [];
    const deleted = [];
    return {
        created,
        deleted,
        async identityBySub(sub) {
            return identities.get(sub) ?? null;
        },
        async identityByUser(userId) {
            return byUser.get(userId) ?? null;
        },
        async link(row) {
            if (identities.has(row.coinpay_sub)) return "conflict";
            identities.set(row.coinpay_sub, { ...row });
            byUser.set(row.user_id, { ...row });
            return "ok";
        },
        async touch() {},
        async createUser({ name, contactEmail }) {
            const id = `user-${++n}`;
            created.push({ id, name, contactEmail });
            return id;
        },
        async deleteUser(id) {
            deleted.push(id);
        }
    };
}

describe("only a trusted key may name a subject", () => {
    afterEach(() => {
        delete process.env.INFERNET_TRUSTED_CLIENT_KEYS;
    });

    it("accepts a registered ifc_ key", () => {
        const key = "ifc_" + "a".repeat(48);
        process.env.INFERNET_TRUSTED_CLIENT_KEYS = `c0mpute-chat:${hashKey(key)}`;
        expect(trustedClientFor(key, process.env.INFERNET_TRUSTED_CLIENT_KEYS)?.name).toBe("c0mpute-chat");
    });

    it("refuses an unregistered key, a wrong prefix and junk", () => {
        const key = "ifc_" + "a".repeat(48);
        process.env.INFERNET_TRUSTED_CLIENT_KEYS = `c0mpute-chat:${hashKey(key)}`;
        const raw = process.env.INFERNET_TRUSTED_CLIENT_KEYS;
        // Right shape, never registered: this is the case that would otherwise
        // let anyone bill a stranger's balance.
        expect(trustedClientFor("ifc_" + "b".repeat(48), raw)).toBeNull();
        // A user's own API key must not pass as a trusted client.
        expect(trustedClientFor("ik_live_" + "a".repeat(43), raw)).toBeNull();
        expect(trustedClientFor("", raw)).toBeNull();
        expect(trustedClientFor(null, raw)).toBeNull();
    });
});

describe("asserting a CoinPay subject", () => {
    it("creates an account the first time and reuses it after", async () => {
        const store = memStore();
        const claims = { sub: "cp-sub-1", email: "someone@example.com", name: "Someone" };

        const first = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims }, store);
        expect(first).toMatchObject({ ok: true, action: "created" });
        expect(store.created).toHaveLength(1);

        const second = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims }, store);
        expect(second).toMatchObject({ ok: true, action: "login", userId: first.userId });
        // Idempotent: a second sign-in must not mint a second account.
        expect(store.created).toHaveLength(1);
    });

    it("keeps two different subjects on two different accounts", async () => {
        const store = memStore();
        const a = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "cp-a" } }, store);
        const b = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "cp-b" } }, store);
        expect(a.userId).not.toBe(b.userId);
    });

    it("binds by sub and never by email, so a shared email cannot take over", async () => {
        const store = memStore();
        const shared = "same@example.com";
        const a = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "cp-a", email: shared } }, store);
        const b = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "cp-b", email: shared } }, store);
        expect(a.userId).not.toBe(b.userId);
        // The email is carried as contact info only.
        expect(store.created.map((c) => c.contactEmail)).toEqual([shared, shared]);
    });

    it("yields to a parallel first sign-in rather than duplicating", async () => {
        const store = memStore();
        // Someone else's link for this sub lands between our createUser and link.
        const racer = { ...store };
        let linked = false;
        const racing = {
            ...store,
            async link(row) {
                if (!linked) {
                    linked = true;
                    // Simulate the other request having already taken the sub.
                    await racer.link({ ...row, user_id: "user-other" });
                    return "conflict";
                }
                return racer.link(row);
            },
            async identityBySub(sub) {
                return racer.identityBySub(sub);
            }
        };
        const r = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "cp-race" } }, racing);
        expect(r).toMatchObject({ ok: true, action: "login", userId: "user-other" });
    });
});
