import "server-only";
import { buildOffer, paymentRequiredHeader } from "@profullstack/x402-gateway";
import { siteUrl } from "@/lib/reservations/order-payment";

/**
 * The 'wallet' funding source: pay a batch's shortfall in the submit request
 * itself, by x402 (USDC through the CoinPay x402 key and CRAWL_PAY_TO wallet,
 * the same rail as self-serve orders). Settlement reuses settleOrderPayment.
 */
const RESOURCE = () => `${siteUrl()}/api/v1/batches`;

export function batchOffer(cents) {
    return buildOffer({
        payTo: process.env["CRAWL_PAY_TO"],
        priceCents: cents,
        resource: RESOURCE(),
        description: `Infernet batch inference: $${(cents / 100).toFixed(2)} shortfall`,
        maxTimeoutSeconds: 600
    });
}

export function batchOfferHeaders(offer) {
    return { "PAYMENT-REQUIRED": paymentRequiredHeader(offer, { url: RESOURCE(), description: offer.accepts?.[0]?.description }) };
}
