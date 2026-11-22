import pkg from "../package.json";

/**
 * Every server-side call to CoinPay (x402 verify/settle, hosted checkout,
 * OAuth token + userinfo, CPR receipts) names this app, so CoinPay's logs and
 * throttle can tell the fleet's apps (all on one IP) apart instead of seeing
 * `node` / `Next.js Middleware`. Edge-safe: it runs inside the proxy too.
 */
export const COINPAY_UA = `infernetprotocol.com/${pkg.version} (+https://infernetprotocol.com)`;

/** fetch with our User-Agent added (kept if the caller already set one). */
export function coinpayFetch(input, init = {}) {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("user-agent")) headers.set("user-agent", COINPAY_UA);
    return fetch(input, { ...init, headers });
}
