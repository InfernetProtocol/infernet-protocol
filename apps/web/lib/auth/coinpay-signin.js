/**
 * Sign in with CoinPay (CoinPay is the house master account).
 *
 * Confidential OIDC client: authorization code + PKCE S256 + state + nonce,
 * redirect https://infernetprotocol.com/api/v1/coinpay/oauth/callback, scopes
 * "openid profile email". The code exchange, id_token checks (iss/aud/exp/nonce)
 * and the userinfo sub match come from @profullstack/coinpay-onboard/oauth.
 *
 * STANDING security rule: a CoinPay login binds to the CoinPay `sub` in
 * public.coinpay_identities. It never signs in to an existing account because
 * the CoinPay email matches (CoinPay never verifies emails), never stores that
 * email as the account's email, and never grants admin or credits from it.
 * Linking CoinPay to an existing account happens only from Settings while
 * signed in to it. A first CoinPay login with no link creates a NEW Infernet
 * account whose auth email is a random placeholder nobody receives mail at;
 * the CoinPay email is kept on the identity row as unverified contact info.
 *
 * The decision logic is written against a small store interface so tests run
 * in memory; supabaseCoinpayStore() is the real one.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { authorizeUrl as cpAuthorizeUrl, pkce, randomToken, SIGN_IN_SCOPES } from "@profullstack/coinpay-onboard/oauth";
import { PLACEHOLDER_EMAIL_DOMAIN, isPlaceholderEmail } from "./coinpay-placeholder.js";

export const COINPAY_ISSUER = "https://coinpayportal.com";
export const CALLBACK_PATH = "/api/v1/coinpay/oauth/callback";
export const OAUTH_COOKIE = "cp_oauth";
export const OAUTH_COOKIE_PATH = "/api/v1/coinpay/oauth";
export const OAUTH_COOKIE_MAX_AGE = 600;

export { PLACEHOLDER_EMAIL_DOMAIN, isPlaceholderEmail };

// Read at request time with bracket access: Next inlines `process.env.NAME`
// at build time, server code included, which would bake a missing secret in.
function runtimeEnv(name, env = process.env) {
    const v = env[name];
    return typeof v === "string" ? v.trim() : "";
}

export function coinpayConfig(env = process.env) {
    const clientId = runtimeEnv("COINPAY_OAUTH_CLIENT_ID", env);
    const clientSecret = runtimeEnv("COINPAY_OAUTH_CLIENT_SECRET", env);
    if (!clientId || !clientSecret) return null;
    const issuer = (runtimeEnv("COINPAY_OAUTH_ISSUER", env) || COINPAY_ISSUER).replace(/\/+$/, "");
    const siteUrl = (runtimeEnv("NEXT_PUBLIC_APP_URL", env) || "https://infernetprotocol.com").replace(/\/+$/, "");
    return { clientId, clientSecret, issuer, siteUrl, redirectUri: siteUrl + CALLBACK_PATH };
}

/** Only same-site paths; anything else falls back to the default landing. */
export function safeCoinpayNext(next, mode = "login") {
    const fallback = mode === "connect" ? "/settings" : "/dashboard";
    if (!next || typeof next !== "string") return fallback;
    if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\r\n\t]/.test(next)) return fallback;
    if (next.length > 512) return fallback;
    return next;
}

/**
 * A new pending request: what the start route keeps in the short-lived
 * httpOnly cookie (HMAC-signed with the client secret), and the authorize URL.
 */
export function beginCoinpay(cfg, { mode = "login", next, userId = null, now = Date.now() } = {}) {
    if (mode !== "login" && mode !== "connect") throw new Error("bad mode");
    const { verifier, challenge } = pkce();
    const pending = {
        state: randomToken(),
        verifier,
        nonce: randomToken(),
        mode,
        next: safeCoinpayNext(next, mode),
        userId: mode === "connect" ? userId : null,
        exp: now + OAUTH_COOKIE_MAX_AGE * 1000,
    };
    const url = cpAuthorizeUrl({
        clientId: cfg.clientId,
        redirectUri: cfg.redirectUri,
        state: pending.state,
        challenge,
        nonce: pending.nonce,
        scopes: SIGN_IN_SCOPES,
        base: cfg.issuer,
    });
    return { url, cookie: sealPending(pending, cfg.clientSecret), pending };
}

export function sealPending(pending, key) {
    const body = Buffer.from(JSON.stringify(pending)).toString("base64url");
    return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function openPending(raw, key, now = Date.now()) {
    const [body, mac, extra] = String(raw ?? "").split(".");
    if (!body || !mac || extra !== undefined) return null;
    const want = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
    const got = Buffer.from(mac);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
        const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (!p || typeof p.state !== "string" || typeof p.verifier !== "string" || typeof p.nonce !== "string") return null;
        if (p.mode !== "login" && p.mode !== "connect") return null;
        if (!(Number(p.exp) > now)) return null;
        return { ...p, next: safeCoinpayNext(p.next, p.mode) };
    } catch {
        return null;
    }
}

export function placeholderEmail() {
    return `cp-${randomBytes(12).toString("hex")}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

/**
 * Decide which Infernet user a verified CoinPay sub belongs to. Never looks at
 * the email: a CoinPay login whose email equals an existing user's gets a NEW
 * account (or the one already bound to its sub), never that user's.
 *
 * @returns {Promise<{ok:true,userId:string,action:"login"|"created"|"linked"} | {ok:false,code:string,error:string}>}
 */
export async function resolveCoinpayUser({ mode, currentUserId, claims }, store) {
    const bound = await store.identityBySub(claims.sub);

    if (mode === "connect") {
        if (!currentUserId) return { ok: false, code: "not_signed_in", error: "Sign in first, then connect CoinPay from Settings." };
        if (bound) {
            if (bound.user_id === currentUserId) return { ok: true, userId: currentUserId, action: "linked" };
            return { ok: false, code: "linked_elsewhere", error: "That CoinPay account is already connected to another Infernet account." };
        }
        if (await store.identityByUser(currentUserId)) {
            return { ok: false, code: "already_connected", error: "This account is already connected to a different CoinPay account. Disconnect it first." };
        }
        const r = await store.link({ user_id: currentUserId, coinpay_sub: claims.sub, coinpay_email: claims.email, coinpay_name: claims.name, created_via: "connect" });
        if (r === "conflict") return { ok: false, code: "linked_elsewhere", error: "That CoinPay account was just connected elsewhere." };
        return { ok: true, userId: currentUserId, action: "linked" };
    }

    if (bound) {
        await store.touch(claims.sub);
        return { ok: true, userId: bound.user_id, action: "login" };
    }
    const userId = await store.createUser({ name: claims.name, contactEmail: claims.email });
    const r = await store.link({ user_id: userId, coinpay_sub: claims.sub, coinpay_email: claims.email, coinpay_name: claims.name, created_via: "signup" });
    if (r === "conflict") {
        // Lost a race with a parallel first login for the same sub: keep theirs.
        await store.deleteUser(userId).catch(() => {});
        const again = await store.identityBySub(claims.sub);
        if (again) return { ok: true, userId: again.user_id, action: "login" };
        throw new Error("coinpay identity conflict");
    }
    return { ok: true, userId, action: "created" };
}

/** Disconnect is refused when CoinPay is the only way into the account. */
export async function disconnectCoinpay(userId, authEmail, store) {
    const mine = await store.identityByUser(userId);
    if (!mine) return { ok: true };
    if (!authEmail || isPlaceholderEmail(authEmail)) {
        return { ok: false, error: "CoinPay is the only way to sign in to this account, so it cannot be disconnected." };
    }
    await store.unlink(userId);
    return { ok: true };
}

export function supabaseCoinpayStore(sb) {
    const cols = "user_id, coinpay_sub, coinpay_email, created_via";
    return {
        async identityBySub(sub) {
            const r = await sb.from("coinpay_identities").select(cols).eq("coinpay_sub", sub).maybeSingle();
            if (r.error) throw new Error(r.error.message);
            return r.data ?? null;
        },
        async identityByUser(userId) {
            const r = await sb.from("coinpay_identities").select(cols).eq("user_id", userId).maybeSingle();
            if (r.error) throw new Error(r.error.message);
            return r.data ?? null;
        },
        async link(row) {
            const r = await sb.from("coinpay_identities").insert({ ...row, last_login_at: new Date().toISOString() });
            if (r.error) {
                if (r.error.code === "23505") return "conflict";
                throw new Error(r.error.message);
            }
            return "ok";
        },
        async unlink(userId) {
            const r = await sb.from("coinpay_identities").delete().eq("user_id", userId);
            if (r.error) throw new Error(r.error.message);
        },
        async touch(sub) {
            await sb.from("coinpay_identities").update({ last_login_at: new Date().toISOString() }).eq("coinpay_sub", sub);
        },
        async createUser({ name, contactEmail }) {
            const r = await sb.auth.admin.createUser({
                email: placeholderEmail(),
                // Confirmed because the address is ours (a magic-link session
                // needs it); isPlaceholderEmail() keeps it from counting as a
                // verified address anywhere (admin, invite bonus, mail).
                email_confirm: true,
                user_metadata: {
                    full_name: name ?? "CoinPay user",
                    signup_via: "coinpay",
                    // Unverified contact info from CoinPay. Never an identity.
                    ...(contactEmail ? { coinpay_contact_email: contactEmail } : {}),
                },
                app_metadata: { signup_via: "coinpay" },
            });
            if (r.error || !r.data?.user) throw new Error(r.error?.message ?? "createUser failed");
            return r.data.user.id;
        },
        async deleteUser(userId) {
            await sb.auth.admin.deleteUser(userId);
        },
    };
}

/**
 * A magic-link token hash for the user's OWN auth email, minted server side
 * (nothing is emailed). The caller redeems it with verifyOtp on the cookie
 * client, which sets the normal Supabase session cookies. Refuses an account
 * whose email is not confirmed: redeeming the link would confirm it.
 */
export async function mintMagicLinkHash(sb, userId) {
    const u = await sb.auth.admin.getUserById(userId);
    const user = u.data?.user;
    if (u.error || !user?.email) return { ok: false, error: "account not found" };
    if (!user.email_confirmed_at) return { ok: false, error: "Confirm this account's email before signing in with CoinPay." };
    const link = await sb.auth.admin.generateLink({ type: "magiclink", email: user.email });
    const tokenHash = link.data?.properties?.hashed_token;
    if (link.error || !tokenHash) return { ok: false, error: "could not start a session" };
    return { ok: true, tokenHash };
}
