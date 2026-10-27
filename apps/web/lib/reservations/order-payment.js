import "server-only";
import { buildOffer, paymentRequiredHeader, paymentResponseHeader, decodePayment, expectedFor, verifyAndSettle } from "@profullstack/x402-gateway";

/**
 * x402 for self-serve orders: the same CoinPay x402 key and USDC wallet the
 * crawl gateway (lib/crawl-gateway.js) sells day passes with, and the same
 * @profullstack/x402-gateway primitives, priced per order instead of per day.
 *
 * Env is read through a non-literal key: Next inlines process.env.NAME at build.
 */
const env = (name) => process.env[name];

/** The proof's single-use nonce, which CoinPay keys replay detection on. */
const nonceOf = (payment) => payment?.payload?.authorization?.nonce ?? null;

export const siteUrl = () => (env("SITE_URL") || env("NEXT_PUBLIC_APP_URL") || "https://infernetprotocol.com").replace(/\/+$/, "");
// COINPAY_API_URL is set with its /api suffix (the payments package wants that); x402 paths add their own.
const coinpayBase = () => (env("COINPAY_API_URL") || "https://coinpayportal.com").replace(/\/+$/, "").replace(/\/api$/, "");

export function x402Configured() {
    return Boolean(env("COINPAY_X402_KEY") && env("CRAWL_PAY_TO"));
}

/** The x402 offer for a quote. The resource is fixed, so a retried POST is held to the same terms. */
export function orderOffer(quote) {
    return buildOffer({
        payTo: env("CRAWL_PAY_TO"),
        priceCents: Math.round(quote.total_usd * 100),
        resource: `${siteUrl()}/api/v1/orders`,
        description: `Infernet reservation: ${quote.label} for ${quote.hours}h`,
        maxTimeoutSeconds: 600
    });
}

export function offerHeaders(offer, description) {
    return { "PAYMENT-REQUIRED": paymentRequiredHeader(offer, { url: `${siteUrl()}/api/v1/orders`, description }) };
}

export function paymentFrom(request) {
    const header = request.headers.get("payment-signature") || request.headers.get("x-payment");
    return header ? decodePayment(header) : null;
}

/** Verify and settle a proof against the offer. Resolves to verifyAndSettle's answer plus the nonce. */
export async function settleOrderPayment(payment, offer, metadata) {
    const expected = expectedFor(payment, offer);
    if (!expected) return { ok: false, reason: "the payment is on a network this offer does not accept" };
    const result = await verifyAndSettle(payment, expected, {
        apiKey: env("COINPAY_X402_KEY"),
        baseUrl: coinpayBase(),
        metadata: { property: "infernetprotocol.com", ...metadata }
    });
    return { ...result, nonce: nonceOf(payment) };
}

export function settlementHeader(result, payment) {
    return { "PAYMENT-RESPONSE": paymentResponseHeader({ transaction: result.txHash ?? result.ref, network: result.network ?? payment?.network, payer: result.payer }) };
}
