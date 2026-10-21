import { beforeAll, describe, expect, it } from "vitest";

const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const HUMAN = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-dest": "document",
  "x-real-ip": "198.51.100.7"
};

let gateway;
beforeAll(async () => {
  process.env.COINPAY_X402_KEY = "cp_live_test";
  process.env.CRAWL_PAY_TO = "0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5";
  ({ gateway } = await import("../apps/web/lib/crawl-gateway.js"));
});

describe("crawl gateway", () => {
  it("answers a training crawler 402 with PAYMENT-REQUIRED", async () => {
    const res = await gateway.handle(new Request("https://infernetprotocol.com/", { headers: { "user-agent": GPTBOT, "x-real-ip": "203.0.113.9" } }));
    expect(res?.status).toBe(402);
    expect(res?.headers.get("payment-required")).toBeTruthy();
  });

  it("offers a $1 day pass at /crawl", async () => {
    const res = await gateway.handle(new Request("https://infernetprotocol.com/crawl", { headers: { accept: "application/json" } }));
    expect(res?.status).toBe(402);
    expect(res?.headers.get("payment-required")).toBeTruthy();
    const body = await res.json();
    expect(String(body.accepts[0].amount)).toBe("1000000");
  });

  it("lets browsers and the API through", async () => {
    expect(await gateway.handle(new Request("https://infernetprotocol.com/", { headers: HUMAN }))).toBeNull();
    expect(await gateway.handle(new Request("https://infernetprotocol.com/api/v1/node/heartbeat", { headers: { "user-agent": GPTBOT } }))).toBeNull();
  });
});
