/**
 * HTTP client for /api/v1/reservations/* — shared by `infernet reservation`,
 * `infernet reservation watch` and the `infernet mcp` server.
 *
 * Base URL:   --url, INFERNET_URL, config.controlPlane.url, else infernetprotocol.com
 * Admin auth: --token, INFERNET_ADMIN_TOKEN, else the `infernet login` bearer
 * Buyer auth: --buyer-token or INFERNET_BUYER_TOKEN (one reservation: show,
 *             report, invoice, keys)
 */
import { loadConfig } from './config.js';

const DEFAULT_URL = 'https://infernetprotocol.com';

export async function resolveClientOptions(opts = {}) {
    const config = await loadConfig().catch(() => null);
    return {
        baseUrl: String(opts.url || process.env.INFERNET_URL || config?.controlPlane?.url || DEFAULT_URL).replace(/\/+$/, ''),
        adminToken: opts.token || process.env.INFERNET_ADMIN_TOKEN || config?.auth?.bearerToken || null,
        buyerToken: opts.buyerToken || process.env.INFERNET_BUYER_TOKEN || null
    };
}

export function createReservationsClient({ baseUrl, adminToken, buyerToken, fetchImpl = fetch }) {
    async function call(method, path, { body, asBuyer = false } = {}) {
        const headers = { accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (asBuyer && buyerToken) headers['x-buyer-token'] = buyerToken;
        else if (adminToken) headers.authorization = `Bearer ${adminToken}`;
        const res = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        if (!res.ok) {
            const detail = json?.details ? `: ${json.details.join('; ')}` : '';
            const err = new Error(`${method} ${path} -> HTTP ${res.status} ${json?.error ?? text.slice(0, 200)}${detail}`);
            err.status = res.status;
            throw err;
        }
        return json?.data ?? json;
    }
    // Per-reservation paths use the buyer token when one is configured and no admin token is.
    const reader = () => Boolean(buyerToken) && !adminToken;
    const enc = encodeURIComponent;

    return {
        list: () => call('GET', '/api/v1/reservations'),
        pricing: () => call('GET', '/api/v1/reservations/pricing'),
        create: (input) => call('POST', '/api/v1/reservations', { body: input }),
        get: (id) => call('GET', `/api/v1/reservations/${enc(id)}`, { asBuyer: reader() }),
        update: (id, patch) => call('PATCH', `/api/v1/reservations/${enc(id)}`, { body: patch }),
        cancel: (id) => call('PATCH', `/api/v1/reservations/${enc(id)}`, { body: { status: 'cancelled' } }),
        listKeys: (id) => call('GET', `/api/v1/reservations/${enc(id)}/keys`, { asBuyer: reader() }),
        issueKey: (id, label) => call('POST', `/api/v1/reservations/${enc(id)}/keys`, { body: { label }, asBuyer: reader() }),
        revokeKey: (id, keyId) => call('DELETE', `/api/v1/reservations/${enc(id)}/keys/${enc(keyId)}`, { asBuyer: reader() }),
        report: (id, { minutes = false } = {}) => call('GET', `/api/v1/reservations/${enc(id)}/report${minutes ? '?minutes=1' : ''}`, { asBuyer: reader() }),
        invoice: (id) => call('GET', `/api/v1/reservations/${enc(id)}/invoice`, { asBuyer: reader() }),
        rotateBuyerToken: (id) => call('POST', `/api/v1/reservations/${enc(id)}/buyer-token`)
    };
}

/** CLI flags -> create body. Kept here so the MCP tool and CLI agree. */
export function createBodyFromFlags(get) {
    const num = (k) => (get(k) === undefined ? undefined : Number(get(k)));
    const body = {
        name: get('name'),
        buyer: get('buyer'),
        operator_name: get('operator'),
        models: get('models') ? String(get('models')).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        provider_id: get('provider-id'),
        endpoint_url: get('endpoint-url'),
        endpoint_api_key: get('endpoint-key'),
        start_at: get('start'),
        hours: num('hours'),
        included_tokens: num('included-tokens'),
        per_key_rps: num('per-key-rps'),
        per_key_concurrency: num('per-key-concurrency'),
        shared_rps: num('shared-rps'),
        shared_concurrency: num('shared-concurrency'),
        required_minutes_per_hour: num('required-minutes'),
        probe_completion: get('probe-completion') === true || get('probe-completion') === 'true' ? true : undefined,
        price_per_hour: get('price-per-hour'),
        gpu_class: get('gpu-class'),
        setup_fee: get('setup-fee'),
        currency: get('currency'),
        notes: get('notes')
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    return body;
}

/** One line per hour: a 60-char minute strip (# confirmed, x failed, . unconfirmed). */
export function renderReport(report, { color = false } = {}) {
    const paint = (c, s) => (color ? `\x1b[${c}m${s}\x1b[0m` : s);
    const statusColor = { compliant: 32, non_compliant: 31, in_progress: 33, upcoming: 90, cancelled: 90 };
    const lines = [];
    lines.push(`reservation ${report.reservation_id}  phase=${report.phase}  tokens ${report.tokens_used}/${report.included_tokens || '∞'}`);
    lines.push(`rule: ${report.rule}`);
    lines.push('');
    for (const h of report.hours) {
        const m = h.minutes;
        const u = h.usage;
        const lh = u.limit_hits;
        lines.push(
            `h${String(h.hour).padStart(3)} ${h.start.replace(':00.000Z', 'Z')}  `
            + paint(statusColor[h.status] ?? 0, h.status.padEnd(13))
            + ` ${String(m.confirmed).padStart(2)}/${m.required} confirmed  ${m.failed} failed  ${m.unconfirmed} unconfirmed`
            + `  req=${u.requests} tok=${u.prompt_tokens + u.completion_tokens} 429s=${lh.rps + lh.concurrency + lh.tokens}`
        );
        for (const f of h.failures.slice(0, 5)) lines.push(`        ${f.minute}  ${f.reason}`);
        if (h.failures.length > 5) lines.push(`        … ${h.failures.length - 5} more`);
    }
    return lines.join('\n');
}

export function renderInvoice(inv) {
    const money = (n) => (n === null ? '(unpriced)' : `${Number(n).toFixed(2)} ${inv.currency}`);
    const lines = [
        `invoice data for reservation ${inv.reservation_id}${inv.buyer ? ` (buyer ${inv.buyer})` : ''}`,
        `operator ${inv.operator_name}  models ${inv.models.join(', ')}`,
        `price per hour ${money(inv.price_per_hour)}${inv.gpu_class ? ` (${inv.gpu_class})` : ''}  setup fee ${money(inv.setup_fee)}  final=${inv.final}`,
        `hours: ${inv.hours_reserved} reserved, ${inv.hours_compliant} compliant, ${inv.hours_non_compliant} non-compliant, ${inv.hours_open} open`,
        ''
    ];
    for (const l of inv.lines) lines.push(`  h${String(l.hour).padStart(3)} ${l.start}  ${l.status.padEnd(13)} ${String(l.confirmed_minutes).padStart(2)} min  ${money(l.amount)}`);
    lines.push('', `amount due: ${money(inv.amount_due)}`, inv.note);
    return lines.join('\n');
}
