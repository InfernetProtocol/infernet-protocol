/**
 * HTTP client for consumer compute credits and invites — shared by
 * `infernet credits`, `infernet redeem`, `infernet invites` and `infernet mcp`.
 *
 * Base URL:  --url, INFERNET_URL, config.controlPlane.url, else infernetprotocol.com
 * User auth: the `infernet login` bearer (config.auth.bearerToken) or --token
 * Admin (mint/list/revoke codes): INFERNET_ADMIN_TOKEN, else the login bearer
 *            of an admin account.
 *
 * Credits are a CONSUMER balance: never node earnings, never withdrawable.
 */
import { loadConfig } from './config.js';

const DEFAULT_URL = 'https://infernetprotocol.com';

export async function resolveCreditsOptions(opts = {}) {
    const config = await loadConfig().catch(() => null);
    const bearer = config?.auth?.bearerToken || null;
    return {
        baseUrl: String(opts.url || process.env.INFERNET_URL || config?.controlPlane?.url || DEFAULT_URL).replace(/\/+$/, ''),
        userToken: opts.token || bearer,
        adminToken: opts.token || process.env.INFERNET_ADMIN_TOKEN || bearer
    };
}

export function createCreditsClient({ baseUrl, userToken, adminToken, fetchImpl = fetch }) {
    async function call(method, path, { body, admin = false } = {}) {
        const token = admin ? adminToken : userToken;
        if (!token) {
            throw new Error(admin
                ? 'admin authorization required: set INFERNET_ADMIN_TOKEN or run `infernet login` as an admin'
                : 'not signed in: run `infernet login` first');
        }
        const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        if (!res.ok) {
            const err = new Error(json?.error ?? `${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
            err.status = res.status;
            err.reason = json?.reason;
            throw err;
        }
        return json?.data ?? json;
    }
    const enc = encodeURIComponent;
    return {
        balance: () => call('GET', '/api/v1/credits'),
        redeem: (code) => call('POST', '/api/v1/credits/redeem', { body: { code } }),
        invites: () => call('GET', '/api/v1/invites'),
        createInvite: (note) => call('POST', '/api/v1/invites', { body: { note: note ?? '' } }),
        revokeInvite: (id) => call('DELETE', `/api/v1/invites/${enc(id)}`),
        acceptInvite: (code) => call('POST', '/api/v1/invites/accept', { body: { code } }),
        listCodes: () => call('GET', '/api/v1/admin/credit-codes', { admin: true }),
        mintCode: (input) => call('POST', '/api/v1/admin/credit-codes', { body: input, admin: true }),
        revokeCode: (id) => call('DELETE', `/api/v1/admin/credit-codes/${enc(id)}`, { admin: true })
    };
}
