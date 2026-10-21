import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCaches,
  apiOrigin,
  createCheckout,
  listPaymentMethods,
  parseWebhookPayload,
  signWebhookPayload,
  toCoinpayMethod,
  verifyWebhookSignature
} from "../packages/payments/src/coinpayportal.js";

const SECRET = "whsec_test_0123456789abcdef";

function fakeFetch(routes, calls = []) {
  return vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const handler = routes[path];
    const body = init.body ? JSON.parse(init.body) : null;
    const [status, json] = handler ? handler(body) : [404, {}];
    return new Response(JSON.stringify(json), { status });
  });
}

const coins = () => [
  200,
  {
    business_id: "biz_1",
    coins: [
      { symbol: "BTC", is_active: true },
      { symbol: "USDC_POL", is_active: true }
    ]
  }
];

describe("CoinPay client", () => {
  beforeEach(() => {
    _resetCaches();
    process.env.COINPAY_API_KEY = "cp_live_test";
    process.env.COINPAY_API_URL = "https://coinpayportal.com/api";
    delete process.env.COINPAY_CHECKOUT_SESSIONS;
    delete process.env.COINPAY_BUSINESS_ID;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("folds /api and the dead api.coinpayportal.com host onto the origin", () => {
    expect(apiOrigin("https://coinpayportal.com/api")).toBe("https://coinpayportal.com");
    expect(apiOrigin("https://api.coinpayportal.com/v1")).toBe("https://coinpayportal.com");
  });

  it("maps the SDK's coin + network onto CoinPay blockchains", () => {
    expect(toCoinpayMethod("USDC", "polygon")).toBe("USDC_POL");
    expect(toCoinpayMethod("usdt", "solana")).toBe("USDT_SOL");
    expect(toCoinpayMethod("BTC")).toBe("BTC");
    expect(toCoinpayMethod("paypal")).toBe("paypal");
  });

  it("lists every coin the business takes plus PayPal while sessions 404", async () => {
    vi.stubGlobal("fetch", fakeFetch({ "/api/supported-coins": coins }));
    const listed = await listPaymentMethods();
    expect(listed.hosted).toBe(false);
    expect(listed.methods.map((m) => m.code)).toEqual(["BTC", "USDC_POL", "paypal"]);
  });

  it("creates a crypto payment with property, account and email metadata", async () => {
    let sent;
    const calls = [];
    vi.stubGlobal(
      "fetch",
      fakeFetch(
        {
          "/api/supported-coins": coins,
          "/api/payments/create": (body) => {
            sent = body;
            return [201, { success: true, payment: { id: "pay_1", payment_address: "0xabc" } }];
          }
        },
        calls
      )
    );
    const out = await createCheckout({
      amountUsd: 2.5,
      orderId: "job_1",
      method: "USDC_POL",
      accountId: "client_1",
      email: "buyer@example.com"
    });
    expect(out).toMatchObject({
      rail: "crypto",
      id: "pay_1",
      paymentUrl: "https://coinpayportal.com/pay/pay_1",
      payAddress: "0xabc"
    });
    expect(sent).toMatchObject({ amount: 2.5, currency: "USD", blockchain: "USDC_POL" });
    expect(sent.metadata).toMatchObject({
      property: "infernetprotocol.com",
      account_id: "client_1",
      email: "buyer@example.com",
      order_id: "job_1"
    });
    expect(calls.every((c) => c.init.headers.authorization === "Bearer cp_live_test")).toBe(true);
  });

  it("refuses a coin the business holds no wallet for", async () => {
    vi.stubGlobal("fetch", fakeFetch({ "/api/supported-coins": coins }));
    await expect(createCheckout({ amountUsd: 1, orderId: "j", method: "DOGE" })).rejects.toMatchObject({
      code: "unsupported_method"
    });
  });

  it("opens a PayPal order on the business", async () => {
    let sent;
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        "/api/supported-coins": coins,
        "/api/paypal/payments/create": (body) => {
          sent = body;
          return [200, { transaction_id: "tx_1", checkout_url: "https://coinpayportal.com/pay/paypal/tx_1" }];
        }
      })
    );
    const out = await createCheckout({ amountUsd: 3, orderId: "j", method: "paypal" });
    expect(out).toMatchObject({ rail: "paypal", id: "tx_1", coin: "PAYPAL" });
    expect(sent).toMatchObject({ business_id: "biz_1", amount: 3 });
  });

  it("switches to hosted checkout sessions once CoinPay has them", async () => {
    let sent;
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        "/api/checkout/sessions": (body) => {
          if (!body || Object.keys(body).length === 0) return [400, { error: "amount is required" }];
          sent = body;
          return [201, { id: "cs_1", url: "https://coinpayportal.com/checkout/cs_1" }];
        }
      })
    );
    const out = await createCheckout({ amountUsd: 4, orderId: "j", accountId: "client_1" });
    expect(out).toMatchObject({ rail: "session", id: "cs_1" });
    expect(sent).toMatchObject({
      amount: 4,
      currency: "USD",
      account_id: "client_1",
      property: "infernetprotocol.com",
      expires_in_minutes: 60
    });
    // SDK/CLI callers send no email; CoinPay requires one, so it falls back.
    expect(sent.customer_email).toBe("client_1@users.infernetprotocol.com");
  });

  it("gives a session an account and an email even when the caller has neither", async () => {
    let sent;
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        "/api/checkout/sessions": (body) => {
          if (!body || Object.keys(body).length === 0) return [400, { error: "amount is required" }];
          sent = body;
          return [201, { id: "cs_2", url: "https://coinpayportal.com/checkout/cs_2" }];
        }
      })
    );
    await createCheckout({ amountUsd: 1, orderId: "job-9" });
    expect(sent.account_id).toBe("order:job-9");
    expect(sent.customer_email).toBe("order-job-9@users.infernetprotocol.com");
    await createCheckout({ amountUsd: 1, orderId: "job-9", accountId: "c", email: " a@b.co " });
    expect(sent).toMatchObject({ account_id: "c", customer_email: "a@b.co" });
  });
});

describe("CoinPay webhooks", () => {
  const body = JSON.stringify({
    id: "evt_pay_1_1700000000",
    type: "payment.confirmed",
    data: { payment_id: "pay_1", status: "confirmed", amount: 2.5, tx_hash: "0xdead" },
    created_at: "2026-10-21T00:00:00.000Z",
    business_id: "biz_1"
  });

  it("verifies CoinPay's t=,v1= signature and rejects tampering or staleness", () => {
    const now = 1_700_000_000;
    const header = signWebhookPayload(body, SECRET, now);
    expect(verifyWebhookSignature(body, header, { secret: SECRET, nowSeconds: now })).toBe(true);
    expect(verifyWebhookSignature(body + " ", header, { secret: SECRET, nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(body, header, { secret: SECRET, nowSeconds: now + 301 })).toBe(false);
    expect(verifyWebhookSignature(body, header.split(",")[1], { secret: SECRET, nowSeconds: now })).toBe(false);
  });

  it("reads the payment id from data, never the top-level event id", () => {
    const ev = parseWebhookPayload(body);
    expect(ev.eventId).toBe("evt_pay_1_1700000000");
    expect(ev.paymentId).toBe("pay_1");
    expect(ev.status).toBe("confirmed");
    expect(ev.txHash).toBe("0xdead");
  });

  it("treats forwarded as paid, expired as failed and underpaid as not paid", () => {
    const mk = (type, status) => parseWebhookPayload({ id: "e", type, data: { payment_id: "p", status } });
    expect(mk("payment.forwarded", "forwarded").status).toBe("confirmed");
    expect(mk("payment.expired", "expired").status).toBe("failed");
    expect(mk("payment.confirmed", "underpaid").status).toBe("pending");
  });

  it("carries order, account and property from session webhooks", () => {
    const ev = parseWebhookPayload({
      id: "e",
      type: "payment.confirmed",
      checkout_session_id: "cs_1",
      account_id: "client_1",
      property: "infernetprotocol.com",
      data: { payment_id: "p", status: "confirmed", metadata: { order_id: "job_1" } }
    });
    expect(ev).toMatchObject({
      checkoutSessionId: "cs_1",
      accountId: "client_1",
      property: "infernetprotocol.com",
      orderId: "job_1"
    });
  });
});
