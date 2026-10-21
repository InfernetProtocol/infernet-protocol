/**
 * CoinPayPortal payment gateway integration.
 *
 * Talks to CoinPay's real API (https://coinpayportal.com):
 *
 *   - hosted checkout sessions   POST /api/checkout/sessions
 *       Used whenever the endpoint exists (feature-detected: a 404 means this
 *       CoinPay does not have it yet; rechecked every 10 minutes). CoinPay then
 *       shows every coin the business takes plus PayPal on its own page.
 *   - crypto                     POST /api/payments/create   { blockchain }
 *       The coin must be one the business holds a wallet for, so the list on
 *       offer is read from GET /api/supported-coins, never assumed.
 *   - PayPal                     POST /api/paypal/payments/create
 *
 * Every rail carries metadata { property, account_id, email, job_id }. The
 * CoinPay id each rail returns is stored on the job/ledger because not every
 * webhook echoes metadata (a crypto `payment.confirmed` and every PayPal event
 * carry only the payment id).
 *
 * Auth is `Authorization: Bearer <business api key>`. Webhooks are signed
 * `X-CoinPay-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.rawBody">` and the
 * body is nested: { id: <EVENT id>, type, data: { payment_id, status, ... } }.
 *
 * Environment (COINPAY_* as written by `coinpay-onboard site`, with the older
 * COINPAYPORTAL_* names still read):
 *   COINPAY_API_KEY          | COINPAYPORTAL_API_KEY          (required)
 *   COINPAY_API_URL          | COINPAYPORTAL_API_BASE_URL     (default https://coinpayportal.com)
 *   COINPAY_WEBHOOK_SECRET   | COINPAYPORTAL_WEBHOOK_SECRET   (webhooks)
 *   COINPAY_BUSINESS_ID      (optional; discovered from the key)
 *   COINPAY_CHECKOUT_SESSIONS  auto | on | off  (default auto)
 *
 * Framework-agnostic: no `server-only`, Next.js helpers or `@/lib/*` alias, so
 * it serves both the Next.js API routes and the CLI.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const COINPAY_DEFAULT_ORIGIN = "https://coinpayportal.com";
export const PROPERTY = "infernetprotocol.com";
export const PAYPAL_METHOD = "paypal";

/** Header CoinPay signs webhooks with (lower-cased for Headers.get). */
export const WEBHOOK_SIGNATURE_HEADER = "x-coinpay-signature";
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** CoinPay `blockchain` values with buyer-facing names. */
export const COIN_LABELS = {
    BTC: "Bitcoin",
    BCH: "Bitcoin Cash",
    ETH: "Ethereum",
    POL: "Polygon",
    SOL: "Solana",
    BNB: "BNB",
    XRP: "XRP",
    ADA: "Cardano",
    DOGE: "Dogecoin",
    USDC_ETH: "USD Coin on Ethereum",
    USDC_POL: "USD Coin on Polygon",
    USDC_SOL: "USD Coin on Solana",
    USDC_BASE: "USD Coin on Base",
    USDT_ETH: "Tether on Ethereum",
    USDT_POL: "Tether on Polygon",
    USDT_SOL: "Tether on Solana",
    USDT_TRON: "Tether on TRON"
};

const NETWORK_SUFFIX = {
    ethereum: "ETH",
    polygon: "POL",
    solana: "SOL",
    base: "BASE",
    tron: "TRON"
};

/**
 * Map a `{ coin, network }` pair (the shape the SDK and payment-coins.js use)
 * or a CoinPay code onto a CoinPay `blockchain`, or `paypal`.
 */
export function toCoinpayMethod(coin, network) {
    const c = String(coin ?? "").trim().toUpperCase();
    if (!c) return null;
    if (c === "PAYPAL") return PAYPAL_METHOD;
    if (c.includes("_")) return c;
    if (c === "USDC" || c === "USDT") {
        const suffix = NETWORK_SUFFIX[String(network ?? "ethereum").toLowerCase()];
        return suffix ? `${c}_${suffix}` : null;
    }
    return c;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function env(...names) {
    for (const name of names) {
        const v = process.env[name];
        if (v && String(v).trim() !== "") return String(v).trim();
    }
    return null;
}

function apiKey() {
    const key = env("COINPAY_API_KEY", "COINPAYPORTAL_API_KEY");
    if (!key) throw new Error("[coinpayportal] Missing required env var: COINPAY_API_KEY");
    return key;
}

/**
 * CoinPay origin. Vault values are `https://coinpayportal.com/api`, and this
 * repo once defaulted to `https://api.coinpayportal.com/v1` (a host that does
 * not exist), so both fold onto the real origin.
 */
export function apiOrigin(base = env("COINPAY_API_URL", "COINPAYPORTAL_API_BASE_URL")) {
    if (!base) return COINPAY_DEFAULT_ORIGIN;
    try {
        const url = new URL(base);
        if (url.hostname === "api.coinpayportal.com") url.hostname = "coinpayportal.com";
        return url.origin;
    } catch {
        return COINPAY_DEFAULT_ORIGIN;
    }
}

async function raw(path, { method = "GET", body, headers = {} } = {}) {
    const url = `${apiOrigin()}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
        return await fetch(url, {
            method,
            headers: {
                authorization: `Bearer ${apiKey()}`,
                "content-type": "application/json",
                accept: "application/json",
                ...headers
            },
            body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
            signal: controller.signal
        });
    } catch (err) {
        throw new Error(`[coinpayportal] Network error calling ${method} ${path}: ${err.message}`);
    } finally {
        clearTimeout(timer);
    }
}

async function readJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text.slice(0, 200) };
    }
}

async function cppFetch(path, init) {
    const response = await raw(path, init);
    const payload = await readJson(response);
    if (!response.ok) {
        const detail = payload?.error || payload?.message || `HTTP ${response.status}`;
        const err = new Error(`[coinpayportal] ${init?.method ?? "GET"} ${path} failed: ${detail}`);
        err.status = response.status;
        err.body = payload;
        throw err;
    }
    return payload;
}

// Module-level caches; fine for a long-lived Next server.
let sessionsKnown = null; // { available, at }
let coinsCache = null; // { coins, businessId, at }
const SESSION_PROBE_TTL_MS = 10 * 60_000;
const COINS_TTL_MS = 5 * 60_000;

/** Test hook. */
export function _resetCaches() {
    sessionsKnown = null;
    coinsCache = null;
}

async function sessionsAvailable() {
    const mode = (env("COINPAY_CHECKOUT_SESSIONS") || "auto").toLowerCase();
    if (mode === "off") return false;
    if (mode === "on") return true;
    if (sessionsKnown && Date.now() - sessionsKnown.at < SESSION_PROBE_TTL_MS) {
        return sessionsKnown.available;
    }
    // An empty body is refused by validation when the route exists and 404s
    // when it does not; nothing is created either way.
    let available = false;
    try {
        const res = await raw("/api/checkout/sessions", { method: "POST", body: "{}" });
        available = res.status !== 404 && res.status !== 405;
    } catch {
        available = false;
    }
    sessionsKnown = { available, at: Date.now() };
    return available;
}

async function supportedCoins() {
    if (coinsCache && Date.now() - coinsCache.at < COINS_TTL_MS) return coinsCache;
    const json = await cppFetch("/api/supported-coins?active_only=true");
    const coins = [
        ...new Set(
            (json.coins ?? [])
                .filter((c) => c && c.is_active !== false && typeof c.symbol === "string")
                .map((c) => c.symbol.toUpperCase())
        )
    ];
    coinsCache = {
        coins,
        businessId: typeof json.business_id === "string" ? json.business_id : null,
        at: Date.now()
    };
    return coinsCache;
}

async function businessId() {
    const configured = env("COINPAY_BUSINESS_ID");
    if (configured) return configured;
    const { businessId: discovered } = await supportedCoins();
    if (!discovered) throw new Error("[coinpayportal] CoinPay business id unknown");
    return discovered;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * What a checkout can offer: every coin the business holds a wallet for, plus
 * PayPal. `hosted` means CoinPay shows that picker itself (checkout sessions).
 *
 * @returns {Promise<{hosted: boolean, methods: Array<{code: string, name: string, rail: "crypto"|"paypal"}>}>}
 */
export async function listPaymentMethods() {
    const [hosted, { coins }] = await Promise.all([sessionsAvailable(), supportedCoins()]);
    const methods = coins.map((code) => ({ code, name: COIN_LABELS[code] ?? code, rail: "crypto" }));
    methods.push({ code: PAYPAL_METHOD, name: "PayPal", rail: "paypal" });
    return { hosted, methods };
}

/**
 * The customer fields a checkout session requires. CoinPay refuses a session
 * without customer_email or account_id (400), but SDK and CLI callers pay for
 * a job with only its id, so a missing email falls back to a stable per-account
 * address on our own domain and a missing account to the order.
 */
export function sessionCustomer({ accountId = null, email = null, orderId }) {
    const account = accountId ? String(accountId) : `order:${orderId}`;
    const mail =
        typeof email === "string" && email.trim()
            ? email.trim()
            : `${account.replace(/[^A-Za-z0-9._-]/g, "-")}@users.${PROPERTY}`;
    return { accountId: account, email: mail };
}

/**
 * Create a CoinPay checkout.
 *
 * @param {object} p
 * @param {number} p.amountUsd
 * @param {string} p.orderId           Our reference (the job id).
 * @param {string} [p.method]          CoinPay blockchain (USDC_POL) or "paypal".
 *                                     Ignored when CoinPay hosts the picker.
 * @param {string} [p.description]
 * @param {string|null} [p.accountId]  Our account (client) id.
 * @param {string|null} [p.email]
 * @param {object} [p.metadata]        Extra metadata.
 * @param {string} [p.successUrl]
 * @param {string} [p.cancelUrl]
 * @param {string} [p.idempotencyKey]
 * @param {boolean} [p.allowHosted=true]
 * @returns {Promise<{rail: "session"|"crypto"|"paypal", id: string, paymentUrl: string,
 *   coin: string, payAddress: string|null, cryptoAmount: string|number|null, expiresAt: string|null}>}
 */
export async function createCheckout({
    amountUsd,
    orderId,
    method,
    description,
    accountId = null,
    email = null,
    metadata = {},
    successUrl,
    cancelUrl,
    idempotencyKey,
    allowHosted = true
}) {
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("[coinpayportal] createCheckout: amountUsd must be a positive number");
    }
    if (!orderId) throw new Error("[coinpayportal] createCheckout: orderId is required");

    const meta = {
        ...metadata,
        property: PROPERTY,
        account_id: accountId ?? null,
        email: email ?? null,
        order_id: String(orderId)
    };
    const idem = idempotencyKey ? { "idempotency-key": String(idempotencyKey) } : {};

    if (allowHosted && (await sessionsAvailable())) {
        const session = sessionCustomer({ accountId, email, orderId });
        const res = await raw("/api/checkout/sessions", {
            method: "POST",
            headers: idem,
            body: {
                amount,
                currency: "USD",
                description,
                customer_email: session.email,
                account_id: session.accountId,
                property: PROPERTY,
                metadata: meta,
                success_url: successUrl,
                cancel_url: cancelUrl,
                expires_in_minutes: 60
            }
        });
        if (res.status === 404 || res.status === 405) {
            sessionsKnown = { available: false, at: Date.now() };
        } else {
            const json = await readJson(res);
            if (!res.ok) {
                const err = new Error(
                    `[coinpayportal] checkout session failed: ${json?.error || `HTTP ${res.status}`}`
                );
                err.status = res.status;
                throw err;
            }
            const s = json.session ?? json;
            if (!s?.id || !s?.url) throw new Error("[coinpayportal] session response missing id/url");
            return {
                rail: "session",
                id: String(s.id),
                paymentUrl: String(s.url),
                coin: "HOSTED",
                payAddress: null,
                cryptoAmount: null,
                expiresAt: s.expires_at ?? null
            };
        }
    }

    const chosen = toCoinpayMethod(method);
    if (!chosen) {
        const err = new Error("[coinpayportal] choose a payment method");
        err.status = 400;
        err.code = "method_required";
        throw err;
    }

    if (chosen === PAYPAL_METHOD) {
        const json = await cppFetch("/api/paypal/payments/create", {
            method: "POST",
            headers: idem,
            body: {
                business_id: await businessId(),
                amount: Math.round(amount * 100) / 100,
                currency: "USD",
                description,
                metadata: meta,
                customer_email: email ?? undefined,
                success_url: successUrl,
                cancel_url: cancelUrl
            }
        });
        if (!json.transaction_id || !(json.checkout_url || json.approve_url)) {
            throw new Error("[coinpayportal] PayPal response missing transaction_id/checkout_url");
        }
        return {
            rail: "paypal",
            id: String(json.transaction_id),
            paymentUrl: String(json.checkout_url || json.approve_url),
            coin: "PAYPAL",
            payAddress: null,
            cryptoAmount: json.amount ?? amount,
            expiresAt: null
        };
    }

    const { coins } = await supportedCoins();
    if (!coins.includes(chosen)) {
        // A real chain this business has no wallet for is otherwise refused by
        // CoinPay only when the buyer presses Pay.
        const err = new Error(`[coinpayportal] ${chosen} is not offered (offered: ${coins.join(", ")})`);
        err.status = 400;
        err.code = "unsupported_method";
        throw err;
    }

    const json = await cppFetch("/api/payments/create", {
        method: "POST",
        headers: idempotencyKey ? { "idempotency-key": `${idempotencyKey}:${chosen}` } : {},
        body: {
            amount,
            currency: "USD",
            blockchain: chosen,
            description,
            metadata: meta,
            success_url: successUrl,
            redirect_url: successUrl,
            cancel_url: cancelUrl,
            expires_in_minutes: 60
        }
    });
    const p = json.payment ?? {};
    if (!p.id) throw new Error("[coinpayportal] payment response missing payment.id");
    return {
        rail: "crypto",
        id: String(p.id),
        paymentUrl: `${apiOrigin()}/pay/${encodeURIComponent(p.id)}`,
        coin: chosen,
        payAddress: p.payment_address ?? null,
        cryptoAmount: p.amount_crypto ?? p.crypto_amount ?? null,
        expiresAt: p.expires_at ?? null
    };
}

/**
 * Public status of a crypto payment (GET /api/payments/:id).
 * @param {string} paymentId
 */
export async function getPayment(paymentId) {
    if (!paymentId) throw new Error("[coinpayportal] getPayment: paymentId is required");
    const json = await cppFetch(`/api/payments/${encodeURIComponent(paymentId)}`);
    return json.payment ?? json;
}

/**
 * Verify a CoinPay webhook signature over the exact raw body.
 *
 * @param {string|Buffer} rawBody
 * @param {string|null|undefined} signatureHeader  `t=<unix>,v1=<hex>`
 * @param {{secret?: string, nowSeconds?: number}} [opts]
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signatureHeader, opts = {}) {
    if (!signatureHeader || typeof signatureHeader !== "string") return false;
    const secret = opts.secret ?? env("COINPAY_WEBHOOK_SECRET", "COINPAYPORTAL_WEBHOOK_SECRET");
    if (!secret) {
        throw new Error("[coinpayportal] Missing required env var: COINPAY_WEBHOOK_SECRET");
    }

    let ts = null;
    const sigs = [];
    for (const part of signatureHeader.split(",")) {
        const [k, v] = part.split("=", 2).map((s) => s?.trim());
        if (k === "t") ts = v;
        else if (k === "v1" && v) sigs.push(v.toLowerCase());
    }
    if (!ts || sigs.length === 0) return false;
    const t = Number(ts);
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(t) || Math.abs(now - t) > WEBHOOK_TOLERANCE_SECONDS) return false;

    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? "");
    const expected = Buffer.from(createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"));
    return sigs.some((sig) => {
        const got = Buffer.from(sig);
        return got.length === expected.length && timingSafeEqual(got, expected);
    });
}

/** Test/dev helper producing CoinPay's header. */
export function signWebhookPayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
    const v1 = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    return `t=${timestamp},v1=${v1}`;
}

const SETTLED_TYPES = new Set([
    "payment.confirmed",
    "payment.forwarded",
    "payment.completed",
    "checkout.session.completed",
    "checkout_session.completed"
]);
const FAILED_TYPES = new Set([
    "payment.expired",
    "payment.failed",
    "checkout.session.expired",
    "checkout_session.expired"
]);
const SETTLED_STATUSES = new Set(["confirmed", "forwarded", "forwarding", "completed", "paid", "captured"]);
const FAILED_STATUSES = new Set(["expired", "failed", "cancelled", "canceled"]);

/**
 * Parse a CoinPay webhook body. Reads the nested `data` first (the top-level
 * `id` is the EVENT id, never the payment id), falling back to the flat shape
 * the older test sender uses.
 *
 * @returns {{eventId: string|null, type: string|null, paymentId: string|null,
 *   checkoutSessionId: string|null, orderId: string|null, accountId: string|null,
 *   property: string|null, status: "confirmed"|"failed"|"pending",
 *   providerStatus: string, txHash: string|null, coin: string|null,
 *   amount: number|string|null, raw: object}}
 */
export function parseWebhookPayload(rawBody) {
    let parsed;
    if (typeof rawBody === "string") {
        try {
            parsed = JSON.parse(rawBody);
        } catch (err) {
            throw new Error(`[coinpayportal] parseWebhookPayload: invalid JSON (${err.message})`);
        }
    } else if (rawBody && typeof rawBody === "object") {
        parsed = rawBody;
    } else {
        throw new Error("[coinpayportal] parseWebhookPayload: rawBody must be string or object");
    }

    const hasData = parsed.data && typeof parsed.data === "object";
    const d = hasData ? parsed.data : parsed;
    const meta = { ...(parsed.metadata ?? {}), ...(d.metadata ?? {}) };
    const type = String(parsed.type ?? parsed.event ?? "").toLowerCase();
    const providerStatus = String(d.status ?? "").toLowerCase();

    let status = "pending";
    if (SETTLED_TYPES.has(type) || SETTLED_STATUSES.has(providerStatus)) status = "confirmed";
    if (FAILED_TYPES.has(type) || (!SETTLED_TYPES.has(type) && FAILED_STATUSES.has(providerStatus))) {
        status = "failed";
    }
    if (providerStatus === "underpaid") status = "pending";

    return {
        eventId: parsed.id ?? null,
        type: type || null,
        paymentId: d.payment_id ?? (hasData ? d.id : null) ?? null,
        checkoutSessionId: d.checkout_session_id ?? parsed.checkout_session_id ?? null,
        orderId: meta.order_id ?? meta.job_id ?? meta.jobId ?? null,
        accountId: parsed.account_id ?? d.account_id ?? meta.account_id ?? null,
        property: parsed.property ?? d.property ?? meta.property ?? null,
        status,
        providerStatus,
        txHash: d.tx_hash ?? d.merchant_tx_hash ?? null,
        coin: d.blockchain ?? d.currency ?? null,
        amount: d.amount_usd ?? d.amount ?? null,
        raw: parsed
    };
}
