import "server-only";
import { COINPAY_UA } from "../coinpay-ua.js";

/**
 * IPIP-0007 phase 2 — HTTP client for CoinPayPortal's CPR API.
 *
 * Thin wrapper. No business logic — building the receipt is in
 * receipts.js, queueing/retry is in queue.js. This module just
 * speaks the wire protocol.
 *
 * Configured via two env vars:
 *   CPR_API_BASE_URL       default: https://coinpayportal.com/api/reputation
 *   CPR_ISSUER_API_KEY     issued at issuer-registration time
 *
 * NOTE: CoinPay's CPR endpoints live under /api/reputation/*, not
 * /api/cpr/*. The CPR brand name is internal; the URL space is
 * /api/reputation/ for continuity with their existing docs.
 */

// CoinPay's CPR endpoints actually live under /api/reputation/* on
// coinpayportal.com (verified against the source at
// ~/src/coinpayportal/src/app/api/reputation/...). The CPR brand
// name is internal — the URL space stayed `/api/reputation/` for
// continuity with the published platform-integration docs.
const DEFAULT_BASE = "https://coinpayportal.com/api/reputation";
const REQUEST_TIMEOUT_MS = 10_000;

export function getCprBaseUrl() {
    return process.env.CPR_API_BASE_URL || DEFAULT_BASE;
}

export function getCprIssuerKey() {
    return process.env.CPR_ISSUER_API_KEY || null;
}

export function isCprConfigured() {
    return !!getCprIssuerKey();
}

/**
 * POST a Receipt to CPR. Resolves with `{ ok, status, body }` on any
 * HTTP response (including 4xx/5xx). Throws only on network failure
 * or timeout — callers decide whether to retry.
 *
 * @param {object} receipt   — full receipt with signatures (or just platform sig in phase 2)
 * @param {{ baseUrl?, apiKey?, fetchImpl? }} [opts]
 */
export async function submitReceipt(receipt, opts = {}) {
    const baseUrl = opts.baseUrl ?? getCprBaseUrl();
    const apiKey = opts.apiKey ?? getCprIssuerKey();
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!apiKey) {
        throw new Error("CPR_ISSUER_API_KEY not configured — cannot submit receipt");
    }

    // POST /receipt (singular) is the submission endpoint;
    // /receipts (plural) is the list endpoint per CoinPay's
    // src/app/api/reputation/receipt/route.ts handler.
    const url = `${baseUrl.replace(/\/+$/, "")}/receipt`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    let res;
    try {
        res = await fetchImpl(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                authorization: `Bearer ${apiKey}`,
                "user-agent": COINPAY_UA
            },
            body: JSON.stringify(receipt),
            signal: ctrl.signal
        });
    } finally {
        clearTimeout(timer);
    }

    let body = null;
    const text = await res.text().catch(() => "");
    if (text) {
        try { body = JSON.parse(text); } catch { body = { raw: text }; }
    }
    return { ok: res.ok, status: res.status, body };
}

/**
 * Classify a CPR response so the queue knows whether to retry,
 * succeed, or give up. Permanent failures (4xx that aren't 408/429)
 * skip retries — they'll never succeed without intervention.
 */
export function classifyResult({ ok, status }) {
    if (ok) return "sent";
    if (status === 408 || status === 429 || status >= 500) return "retry";
    if (status >= 400) return "permanent_fail";
    return "retry";
}
