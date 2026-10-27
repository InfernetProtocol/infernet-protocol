/**
 * HTTP client for self-serve orders (/api/v1/orders/*) — shared by
 * `infernet order` and the `infernet mcp` order tools.
 *
 * Paying:
 *   checkout  POST with pay: "checkout" -> a CoinPay checkout URL (any coin, PayPal)
 *   x402      the 402 offer is signed with X402_PRIVATE_KEY (or --key-file) by
 *             @profullstack/x402-client and the reservation comes back in the
 *             same call. --max-usd caps what it will sign (default 50).
 */
import { readFileSync } from 'node:fs';
import { createClient as createX402Client } from '@profullstack/x402-client';

export const DEFAULT_MAX_USD = 50;

export function x402KeyFrom({ key, keyFile } = {}) {
    if (key) return String(key).trim();
    if (keyFile) return readFileSync(keyFile, 'utf8').trim();
    return process.env.X402_PRIVATE_KEY ? process.env.X402_PRIVATE_KEY.trim() : null;
}

export function createOrdersClient({ baseUrl, fetchImpl = fetch, x402 = createX402Client }) {
    async function call(method, path, { body, headers = {} } = {}) {
        const res = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        if (!res.ok) {
            const detail = json?.details ? `: ${json.details.join('; ')}` : json?.hint ? ` (${json.hint})` : '';
            const err = new Error(`${method} ${path} -> HTTP ${res.status} ${json?.error ?? text.slice(0, 200)}${detail}`);
            err.status = res.status;
            err.body = json;
            throw err;
        }
        return json?.data ?? json;
    }

    return {
        capacity: () => call('GET', '/api/v1/orders/capacity'),
        status: (id, buyerToken) => call('GET', `/api/v1/orders/${encodeURIComponent(id)}`, { headers: { 'x-buyer-token': buyerToken } }),
        /** Quote without paying: the 402 body (offer + quote). */
        async quote(input) {
            const res = await fetchImpl(`${baseUrl}/api/v1/orders`, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify(input)
            });
            const json = await res.json().catch(() => null);
            if (res.status === 402) return json;
            throw Object.assign(new Error(`quote -> HTTP ${res.status} ${json?.error ?? ''}${json?.details ? `: ${json.details.join('; ')}` : ''}`), { status: res.status, body: json });
        },
        checkout: (input) => call('POST', '/api/v1/orders', { body: { ...input, pay: 'checkout' } }),
        /** Pay the order's x402 offer and get the reservation back. */
        async payX402(input, { key, maxUsd = DEFAULT_MAX_USD } = {}) {
            if (!key) throw new Error('x402 needs a wallet key: set X402_PRIVATE_KEY or pass --key-file (or pay with --checkout)');
            const client = x402({ key, maxUsd: Number(maxUsd), fetch: fetchImpl });
            const result = await client.pay(`${baseUrl}/api/v1/orders`, {
                init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }
            });
            const body = result.body;
            if (result.status >= 400) throw Object.assign(new Error(`order -> HTTP ${result.status} ${body?.error ?? ''}`), { status: result.status, body });
            return { ...(body?.data ?? body), paid_usd: result.amountUsd, payer: result.payer, network: result.network };
        }
    };
}

/** CLI flags -> order body. Kept here so the MCP tool and CLI agree. */
export function orderBodyFromFlags(get) {
    const body = {
        gpu_class: get('gpu'),
        models: get('models') ? String(get('models')).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        hours: get('hours') === undefined ? undefined : Number(get('hours')),
        start_at: get('start'),
        name: get('name'),
        email: get('email'),
        provider_id: get('provider-id')
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    return body;
}
