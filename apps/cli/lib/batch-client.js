/**
 * HTTP client for paid batch inference, the compute balance and API keys
 * (/api/v1/batches/*, /api/v1/billing/*, /api/v1/keys) — shared by
 * `infernet batch`, `infernet billing`, `infernet keys` and `infernet mcp`.
 *
 * Auth: an API key (--key, INFERNET_API_KEY: ik_live_...) or the
 * `infernet login` bearer. Keys are created/revoked with the login bearer.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';

const DEFAULT_URL = 'https://infernetprotocol.com';

export async function resolveBatchOptions(opts = {}) {
    const config = await loadConfig().catch(() => null);
    const bearer = config?.auth?.bearerToken || null;
    return {
        baseUrl: String(opts.url || process.env.INFERNET_URL || config?.controlPlane?.url || DEFAULT_URL).replace(/\/+$/, ''),
        apiKey: opts.key || process.env.INFERNET_API_KEY || null,
        userToken: opts.token || bearer
    };
}

/** Parse a JSONL file of { custom_id, messages, max_tokens, temperature? } lines. */
export function readBatchJsonl(text) {
    const items = [];
    String(text).split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        let row;
        try { row = JSON.parse(line); } catch { throw new Error(`line ${i + 1}: not valid JSON`); }
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`line ${i + 1}: expected an object`);
        items.push(row);
    });
    if (items.length === 0) throw new Error('the file has no items');
    return items;
}

export function readBatchFile(path) {
    return readBatchJsonl(readFileSync(path, 'utf8'));
}

export function createBatchClient({ baseUrl, apiKey, userToken, fetchImpl = fetch }) {
    async function call(method, path, { body, signedIn = false, raw = false, headers: extra = {} } = {}) {
        const token = signedIn ? userToken : (apiKey || userToken);
        if (!token) {
            throw new Error(signedIn
                ? 'not signed in: run `infernet login` first'
                : 'set INFERNET_API_KEY (ik_live_..., from `infernet keys create`) or run `infernet login`');
        }
        const headers = { accept: raw ? '*/*' : 'application/json', authorization: `Bearer ${token}`, ...extra };
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        if (raw && res.ok) return text;
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        if (!res.ok) {
            const detail = json?.details ? `: ${json.details.join('; ')}` : '';
            const err = new Error(`${json?.error ?? `HTTP ${res.status} ${text.slice(0, 200)}`}${detail}`);
            err.status = res.status;
            err.body = json;
            throw err;
        }
        return json?.data ?? json;
    }
    const enc = encodeURIComponent;
    return {
        quote: (body) => call('POST', '/api/v1/batches/quote', { body }),
        /** max_cost_usd and idempotency_key are required; the server refuses without them. */
        submit: (body) => call('POST', '/api/v1/batches', { body }),
        status: (id) => call('GET', `/api/v1/batches/${enc(id)}`),
        results: (id) => call('GET', `/api/v1/batches/${enc(id)}/results`, { raw: true }),
        cancel: (id) => call('POST', `/api/v1/batches/${enc(id)}/cancel`),
        receipt: (id) => call('GET', `/api/v1/batches/${enc(id)}/receipt`),
        balance: () => call('GET', '/api/v1/billing/balance'),
        topup: (amountUsd) => call('POST', '/api/v1/billing/topup', { body: { amount_usd: amountUsd } }),
        topupStatus: (id) => call('GET', `/api/v1/billing/topup/${enc(id)}`),
        setFunding: (order) => call('PUT', '/api/v1/billing/funding', { body: { funding_order: order } }),
        createKey: (name) => call('POST', '/api/v1/keys', { body: { name: name ?? null }, signedIn: true }),
        listKeys: () => call('GET', '/api/v1/keys', { signedIn: true }),
        revokeKey: (id) => call('DELETE', `/api/v1/keys/${enc(id)}`, { signedIn: true })
    };
}

export function formatBillingBalance(b = {}) {
    return [
        `Earned (spendable on compute): $${b.earned_spendable_usd ?? '0'}   confirmed node earnings, Infernet + c0mpute`,
        `Prepaid available:             $${b.prepaid_available_usd ?? '0'}   (balance $${b.balance_usd ?? '0'}, held $${b.held_usd ?? '0'})`,
        `Total spendable:               $${b.total_spendable_usd ?? '0'}`,
        `Funding order:                 ${(b.funding_order ?? []).join(' > ')}`
    ].join('\n');
}
