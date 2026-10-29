import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    PLACEHOLDER_EMAIL_DOMAIN,
    beginCoinpay,
    coinpayConfig,
    disconnectCoinpay,
    isPlaceholderEmail,
    openPending,
    resolveCoinpayUser,
    safeCoinpayNext,
    sealPending,
} from "@/lib/auth/coinpay-signin";
import { isAdminUser } from "@/lib/auth/admin";

const ENV = {
    COINPAY_OAUTH_CLIENT_ID: "cp_test",
    COINPAY_OAUTH_CLIENT_SECRET: "test-secret",
    NEXT_PUBLIC_APP_URL: "https://infernet.test",
};

/** An in-memory coinpay_identities table plus auth users. */
function memoryStore(existingUsers = []) {
    const rows = [];
    const users = new Set(existingUsers);
    let n = 0;
    return {
        rows,
        users,
        async identityBySub(sub) {
            return rows.find((r) => r.coinpay_sub === sub) ?? null;
        },
        async identityByUser(userId) {
            return rows.find((r) => r.user_id === userId) ?? null;
        },
        async link(row) {
            if (rows.some((r) => r.coinpay_sub === row.coinpay_sub || r.user_id === row.user_id)) return "conflict";
            rows.push(row);
            return "ok";
        },
        async unlink(userId) {
            const i = rows.findIndex((r) => r.user_id === userId);
            if (i >= 0) rows.splice(i, 1);
        },
        async touch() {},
        async createUser() {
            const id = `new-${++n}`;
            users.add(id);
            return id;
        },
        async deleteUser(id) {
            users.delete(id);
        },
    };
}

describe("Sign in with CoinPay: start", () => {
    it("is off without a client, and reads the env at request time", () => {
        expect(coinpayConfig({})).toBeNull();
        expect(coinpayConfig(ENV).redirectUri).toBe("https://infernet.test/api/v1/coinpay/oauth/callback");
    });

    it("sends PKCE S256, state, nonce, the exact redirect and only the sign-in scopes", () => {
        const { url, cookie, pending } = beginCoinpay(coinpayConfig(ENV), { next: "/auth/cli/abc" });
        const u = new URL(url);
        expect(u.origin + u.pathname).toBe("https://coinpayportal.com/api/oauth/authorize");
        expect(u.searchParams.get("code_challenge_method")).toBe("S256");
        expect(u.searchParams.get("code_challenge")).toBeTruthy();
        expect(u.searchParams.get("state")).toBe(pending.state);
        expect(u.searchParams.get("nonce")).toBe(pending.nonce);
        expect(u.searchParams.get("scope")).toBe("openid profile email");
        expect(u.searchParams.get("redirect_uri")).toBe("https://infernet.test/api/v1/coinpay/oauth/callback");
        expect(openPending(cookie, "test-secret")).toMatchObject({ state: pending.state, mode: "login", next: "/auth/cli/abc" });
    });

    it("refuses a forged, tampered or expired pending cookie", () => {
        const { cookie } = beginCoinpay(coinpayConfig(ENV), {});
        expect(openPending(cookie, "another-secret")).toBeNull();
        const [body, mac] = cookie.split(".");
        const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), mode: "connect", userId: "victim" })).toString("base64url");
        expect(openPending(`${evil}.${mac}`, "test-secret")).toBeNull();
        expect(openPending(sealPending({ state: "s", verifier: "v", nonce: "n", mode: "login", exp: 1 }, "test-secret"), "test-secret")).toBeNull();
        expect(openPending(undefined, "test-secret")).toBeNull();
    });

    it("only follows same-site paths afterwards", () => {
        expect(safeCoinpayNext("//evil.example")).toBe("/dashboard");
        expect(safeCoinpayNext("https://evil.example")).toBe("/dashboard");
        expect(safeCoinpayNext("/\\evil")).toBe("/dashboard");
        expect(safeCoinpayNext(null, "connect")).toBe("/settings");
    });
});

describe("Sign in with CoinPay: binding by sub (STANDING rule)", () => {
    const victimEmail = "victim@example.org";

    it("an email that matches an existing account does NOT get that account", async () => {
        const store = memoryStore(["victim-id"]);
        const r = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "attacker", email: victimEmail, name: null } }, store);
        expect(r.ok).toBe(true);
        expect(r.action).toBe("created");
        expect(r.userId).not.toBe("victim-id");
        // Next time the same sub lands on the same new account.
        const again = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "attacker", email: victimEmail, name: null } }, store);
        expect(again).toMatchObject({ ok: true, action: "login", userId: r.userId });
    });

    it("linking needs a signed-in session, and a sub binds to one account only", async () => {
        const store = memoryStore(["victim-id", "other-id"]);
        const noSession = await resolveCoinpayUser({ mode: "connect", currentUserId: null, claims: { sub: "s1", email: null, name: null } }, store);
        expect(noSession).toMatchObject({ ok: false, code: "not_signed_in" });
        expect(store.rows).toHaveLength(0);

        const linked = await resolveCoinpayUser({ mode: "connect", currentUserId: "victim-id", claims: { sub: "s1", email: null, name: null } }, store);
        expect(linked).toMatchObject({ ok: true, action: "linked", userId: "victim-id" });
        const login = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "s1", email: "x@y.co", name: null } }, store);
        expect(login).toMatchObject({ ok: true, action: "login", userId: "victim-id" });

        const elsewhere = await resolveCoinpayUser({ mode: "connect", currentUserId: "other-id", claims: { sub: "s1", email: null, name: null } }, store);
        expect(elsewhere).toMatchObject({ ok: false, code: "linked_elsewhere" });
        const second = await resolveCoinpayUser({ mode: "connect", currentUserId: "victim-id", claims: { sub: "s2", email: null, name: null } }, store);
        expect(second).toMatchObject({ ok: false, code: "already_connected" });
    });

    it("disconnect is refused when CoinPay is the only way in", async () => {
        const store = memoryStore(["victim-id"]);
        await resolveCoinpayUser({ mode: "connect", currentUserId: "victim-id", claims: { sub: "s1", email: null, name: null } }, store);
        const only = await resolveCoinpayUser({ mode: "login", currentUserId: null, claims: { sub: "s2", email: null, name: null } }, store);
        const placeholder = `cp-abc@${PLACEHOLDER_EMAIL_DOMAIN}`;
        expect(await disconnectCoinpay(only.userId, placeholder, store)).toMatchObject({ ok: false });
        expect(await disconnectCoinpay("victim-id", victimEmail, store)).toEqual({ ok: true });
        expect(await store.identityByUser("victim-id")).toBeNull();
    });

    it("a placeholder address is never a confirmed email for admin", () => {
        const placeholder = `cp-abc@${PLACEHOLDER_EMAIL_DOMAIN}`;
        expect(isPlaceholderEmail(placeholder)).toBe(true);
        expect(isPlaceholderEmail(victimEmail)).toBe(false);
        expect(isAdminUser({ id: "x", email: placeholder, email_confirmed_at: "2026-10-29" }, { INFERNET_ADMIN_EMAILS: placeholder })).toBe(false);
    });
});

// The callback route end to end, with Supabase and CoinPay stubbed.
const sb = { verifyOtp: vi.fn(), signOut: vi.fn(), currentUser: null };
const identities = memoryStore(["victim-id"]);
vi.mock("@/lib/supabase/auth-server", () => ({
    getSupabaseAuthClient: async () => ({
        auth: {
            getUser: async () => ({ data: { user: sb.currentUser } }),
            verifyOtp: async (args) => sb.verifyOtp(args),
            signOut: async () => sb.signOut(),
        },
    }),
    getCurrentUser: async () => sb.currentUser,
}));
vi.mock("@/lib/supabase/server", () => ({
    getSupabaseServerClient: () => ({
        auth: {
            admin: {
                getUserById: async (id) => ({ data: { user: { id, email: `${id}@${PLACEHOLDER_EMAIL_DOMAIN}`, email_confirmed_at: "x" } } }),
                generateLink: async () => ({ data: { properties: { hashed_token: "hash" } } }),
            },
        },
    }),
}));
vi.mock("@/lib/auth/coinpay-signin", async (orig) => {
    const real = await orig();
    return { ...real, supabaseCoinpayStore: () => identities };
});
vi.mock("@/lib/credits/sign-in", () => ({ afterSignIn: async () => null }));
vi.mock("../apps/web/node_modules/next/cache.js", () => ({ revalidatePath: () => {} }));
// next/server lives in apps/web; the route only needs redirect + cookies.
vi.mock("../apps/web/node_modules/next/server.js", () => {
    class NextResponse extends Response {
        static redirect(url, status = 307) {
            const res = new NextResponse(null, { status, headers: { location: String(url) } });
            return res;
        }
        cookies = { set: () => {}, delete: () => {} };
    }
    return { NextResponse };
});

describe("Sign in with CoinPay: callback", () => {
    let GET;
    let pending;
    let cookie;
    const grant = { sub: "cb-user", email: "victim@example.org" };

    beforeEach(async () => {
        Object.assign(process.env, ENV);
        ({ GET } = await import("@/app/api/v1/coinpay/oauth/callback/route.js"));
        ({ pending, cookie } = beginCoinpay(coinpayConfig(ENV), { next: "/dashboard" }));
        sb.verifyOtp.mockReset().mockResolvedValue({ data: { user: { id: "u" } }, error: null });
        sb.currentUser = null;
        const exp = Math.floor(Date.now() / 1000) + 600;
        const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
        vi.stubGlobal("fetch", async (url, init = {}) => {
            const path = new URL(String(url)).pathname;
            const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
            if (path === "/api/oauth/token") {
                const p = new URLSearchParams(String(init.body));
                expect(p.get("client_secret")).toBe("test-secret");
                expect(p.get("code_verifier")).toBe(pending.verifier);
                const id = `${b64({ alg: "RS256" })}.${b64({ iss: "https://coinpayportal.com", aud: "cp_test", sub: grant.sub, exp, nonce: grant.nonce ?? pending.nonce })}.sig`;
                return json({ access_token: "at", expires_in: 3600, id_token: id });
            }
            if (path === "/api/oauth/userinfo") return json({ sub: grant.sub, email: grant.email, email_verified: false });
            return new Response("{}", { status: 404 });
        });
    });

    const call = (query, withCookie = cookie) => {
        const req = new Request(`https://infernet.test/api/v1/coinpay/oauth/callback?${new URLSearchParams(query)}`);
        req.cookies = { get: (name) => (name === "cp_oauth" && withCookie ? { value: withCookie } : undefined) };
        return GET(req);
    };

    it("signs a new CoinPay user into a NEW account, not the email's owner", async () => {
        const res = await call({ code: "c", state: pending.state });
        expect(res.headers.get("location")).toBe("https://infernet.test/dashboard");
        expect(sb.verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "hash" });
        const row = await identities.identityBySub("cb-user");
        expect(row.user_id).not.toBe("victim-id");
        expect(row.coinpay_email).toBe("victim@example.org");
    });

    it("rejects a bad state, a missing cookie and a bad nonce", async () => {
        expect((await call({ code: "c", state: "forged" })).headers.get("location")).toContain("state+mismatch");
        expect((await call({ code: "c", state: pending.state }, "")).headers.get("location")).toContain("/auth/login?error=");
        grant.nonce = "wrong";
        try {
            expect((await call({ code: "c", state: pending.state })).headers.get("location")).toContain("/auth/login?error=");
        } finally {
            delete grant.nonce;
        }
        expect(sb.verifyOtp).not.toHaveBeenCalled();
    });
});
