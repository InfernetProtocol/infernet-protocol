import { createGateway } from "@profullstack/x402-gateway";
import { x402Proxy } from "@profullstack/x402-gateway/next";

/**
 * Sells crawl access to AI training crawlers (GPTBot, ClaudeBot, CCBot, ...)
 * by the day over x402, settled by CoinPay in USDC, with a CoinPay checkout
 * for people at /crawl. Browsers, Googlebot and AI chat/search fetchers pass
 * through untouched.
 *
 * Runs inside the proxy, so nothing here may import Node-only modules. The env
 * is read through a non-literal key on purpose: Next inlines `process.env.NAME`
 * at build time, and these are runtime secrets.
 */
const env = (name) => process.env[name];

export const gateway = createGateway({
    siteUrl: (env("SITE_URL") || env("NEXT_PUBLIC_SITE_URL") || "https://infernetprotocol.com").replace(/\/+$/, ""),
    siteName: "Infernet Protocol",
    coinpay: { apiKey: env("COINPAY_X402_KEY") },
    payTo: env("CRAWL_PAY_TO"),
    contact: "mailto:anthony@profullstack.com",
    // The API (nodes, the CLI, health checks, webhooks), the installer and
    // the crawl manifests are never charged. Invite links (/i/<code>) are never
    // gated either: a shared invite must always reach signup.
    openPaths: ["/api/", "/i/", "/install.sh", "/robots.txt", "/sitemap.xml", "/llms.txt", "/.well-known/"],
    // Signed-in users (Supabase auth cookie) are never charged.
    exempt: (request) => /(?:^|;\s*)sb-[^=]*-auth-token/.test(request.headers.get("cookie") ?? "")
});

/** Resolves to a Response for a refused crawler, or undefined to carry on. */
export const gate = x402Proxy(gateway);
