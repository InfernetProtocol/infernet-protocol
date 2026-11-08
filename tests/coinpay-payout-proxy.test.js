import { afterEach, describe, expect, it, vi } from "vitest";
import { createPayout } from "../packages/payments/src/coinpayportal.js";

const args = { recipientWallet: "0xabc", amountUsd: 1, cryptocurrency: "USDC_POL", apiKey: "k", idempotencyKey: "payout:1" };
const reply = (status, body, type = "application/json") =>
    vi.fn(async () => new Response(body, { status, headers: { "content-type": type } }));

describe("createPayout outcome when CoinPay is down", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("an HTML 503 from the proxy is refused (nothing sent), not unknown", async () => {
        vi.stubGlobal("fetch", reply(503, "<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>", "text/html"));
        const out = await createPayout(args);
        expect(out.outcome).toBe("failed");
        expect(out.payoutId).toBeUndefined();
        expect(out.error).toMatch(/nothing sent/);
    });

    it("an empty 502 is refused too", async () => {
        vi.stubGlobal("fetch", reply(502, ""));
        expect((await createPayout(args)).outcome).toBe("failed");
    });

    it("a JSON 503 from CoinPay itself stays unknown", async () => {
        vi.stubGlobal("fetch", reply(503, JSON.stringify({ success: false, error: "broadcast pending" })));
        expect((await createPayout(args)).outcome).toBe("unknown");
    });

    it("a 504 stays unknown even without JSON", async () => {
        vi.stubGlobal("fetch", reply(504, "<html>Gateway Time-out</html>", "text/html"));
        expect((await createPayout(args)).outcome).toBe("unknown");
    });
});
