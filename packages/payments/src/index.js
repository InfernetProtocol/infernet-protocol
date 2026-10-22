/**
 * Payments facade.
 *
 * Re-exports the single active gateway (CoinPayPortal) behind a stable
 * surface so route handlers and the CLI can import from
 * "@infernetprotocol/payments" without caring how CoinPay is called.
 */

export {
  createCheckout,
  createPayout,
  listPaymentMethods,
  getPayment,
  toCoinpayMethod,
  verifyWebhookSignature,
  signWebhookPayload,
  parseWebhookPayload,
  apiOrigin,
  WEBHOOK_SIGNATURE_HEADER,
  PAYPAL_METHOD,
  PROPERTY
} from "./coinpayportal.js";
