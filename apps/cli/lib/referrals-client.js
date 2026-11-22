/**
 * HTTP client for node referrals: `infernet referral` and the MCP tools
 * referral_link / referral_stats. Thin: the server does every check.
 *
 * Base URL:  --url, INFERNET_URL, config.controlPlane.url, else infernetprotocol.com
 * Auth:      the `infernet login` bearer (config.auth.bearerToken) or --token
 * Admin:     INFERNET_ADMIN_TOKEN, else the login bearer of an admin account
 */
import { loadConfig } from './config.js';

const DEFAULT_URL = 'https://infernetprotocol.com';

export async function resolveReferralOptions(opts = {}) {
    const config = await loadConfig().catch(() => null);
    const bearer = config?.auth?.bearerToken || null;
    return {
        baseUrl: String(opts.url || process.env.INFERNET_URL || config?.controlPlane?.url || DEFAULT_URL).replace(/\/+$/, ''),
        userToken: opts.token || bearer,
        adminToken: opts.token || process.env.INFERNET_ADMIN_TOKEN || bearer
    };
}

export function createReferralsClient({ baseUrl, userToken, adminToken, fetchImpl = fetch }) {
    async function call(method, path, { body, admin = false } = {}) {
        const token = admin ? adminToken : userToken;
        if (!token) {
            throw new Error(admin
                ? 'admin authorization required: set INFERNET_ADMIN_TOKEN or run `infernet login` as an admin'
                : 'not signed in: run `infernet login` first');
        }
        const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        if (!res.ok) {
            const err = new Error(json?.error ?? `${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        return json?.data ?? json;
    }
    return {
        /** Your link (created on first call; the commission term is set then). */
        link: () => call('POST', '/api/v1/referrals', { body: {} }),
        stats: () => call('GET', '/api/v1/referrals'),
        setAddress: (coin, network, address) => call('POST', '/api/v1/referrals/address', { body: { coin, network, address } }),
        payout: (amountUsd) => call('POST', '/api/v1/referrals/payout', { body: amountUsd == null ? {} : { amount_usd: amountUsd } }),
        results: () => call('GET', '/api/v1/admin/referrals', { admin: true })
    };
}
