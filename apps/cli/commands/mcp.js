/**
 * `infernet mcp` — Model Context Protocol server over stdio.
 *
 * Exposes managed-endpoint reservations (docs/prd/16-managed-endpoints.md) as
 * MCP tools so an agent can book, key, monitor and reconcile reservations.
 * Same auth as `infernet reservation` (INFERNET_ADMIN_TOKEN / login bearer, or
 * INFERNET_BUYER_TOKEN for the read-only buyer tools).
 *
 *   claude mcp add infernet -- infernet mcp
 *
 * Newline-delimited JSON-RPC 2.0, no dependencies.
 */
import { createInterface } from 'node:readline';
import { resolveClientOptions, createReservationsClient } from '../lib/reservations-client.js';
import { CURRENT_VERSION } from '../lib/version.js';

const PROTOCOL_VERSION = '2025-06-18';

const id = { type: 'string', description: 'reservation id (uuid)' };

export const TOOLS = [
    {
        name: 'reservation_list',
        description: 'List managed-endpoint reservations (admin).',
        inputSchema: { type: 'object', properties: {} },
        run: (c) => c.list()
    },
    {
        name: 'reservation_create',
        description: 'Book a managed endpoint: exact model ids on one named operator target (provider_id of an Infernet node, or an OpenAI-compatible endpoint_url), starting at a whole UTC hour for N hours, with included tokens and per-key/shared rps + concurrency limits. Returns the reservation and a one-time buyer token. Unpriced unless gpu_class or price_per_hour is passed.',
        inputSchema: {
            type: 'object',
            required: ['name', 'operator_name', 'models', 'start_at', 'hours'],
            properties: {
                name: { type: 'string' },
                buyer: { type: 'string' },
                operator_name: { type: 'string' },
                models: { type: 'array', items: { type: 'string' } },
                provider_id: { type: 'string' },
                endpoint_url: { type: 'string' },
                endpoint_api_key: { type: 'string' },
                start_at: { type: 'string', description: 'ISO timestamp on a whole UTC hour' },
                hours: { type: 'integer', minimum: 1, maximum: 720 },
                included_tokens: { type: 'integer', minimum: 0 },
                per_key_rps: { type: 'integer', minimum: 1 },
                per_key_concurrency: { type: 'integer', minimum: 1 },
                shared_rps: { type: 'integer', minimum: 1 },
                shared_concurrency: { type: 'integer', minimum: 1 },
                required_minutes_per_hour: { type: 'integer', minimum: 1, maximum: 60 },
                probe_completion: { type: 'boolean' },
                gpu_class: { type: 'string', enum: ['l40s', 'a100', 'h100', 'h100x2'], description: 'Prices the reservation from the list (GET /api/v1/reservations/pricing); a lower price_per_hour is refused.' },
                price_per_hour: { type: 'number', minimum: 0 },
                setup_fee: { type: 'number', minimum: 0 },
                currency: { type: 'string' },
                notes: { type: 'string' }
            }
        },
        run: (c, a) => c.create(a)
    },
    { name: 'reservation_get', description: 'Show one reservation.', inputSchema: { type: 'object', required: ['id'], properties: { id } }, run: (c, a) => c.get(a.id) },
    { name: 'reservation_cancel', description: 'Cancel a reservation (keys stop working; hours become non-billable).', inputSchema: { type: 'object', required: ['id'], properties: { id } }, run: (c, a) => c.cancel(a.id) },
    { name: 'reservation_keys', description: 'List a reservation\'s API keys (prefixes only).', inputSchema: { type: 'object', required: ['id'], properties: { id } }, run: (c, a) => c.listKeys(a.id) },
    {
        name: 'reservation_key_issue',
        description: 'Issue an API key on a reservation for a reseller\'s customer. The key is returned once.',
        inputSchema: { type: 'object', required: ['id'], properties: { id, label: { type: 'string' } } },
        run: (c, a) => c.issueKey(a.id, a.label)
    },
    {
        name: 'reservation_key_revoke',
        description: 'Revoke a reservation API key.',
        inputSchema: { type: 'object', required: ['id', 'key_id'], properties: { id, key_id: { type: 'string' } } },
        run: (c, a) => c.revokeKey(a.id, a.key_id)
    },
    {
        name: 'reservation_report',
        description: 'Per-hour availability/compliance report with usage (requests, tokens, limit hits). minutes=true includes every per-minute probe record.',
        inputSchema: { type: 'object', required: ['id'], properties: { id, minutes: { type: 'boolean' } } },
        run: (c, a) => c.report(a.id, { minutes: a.minutes === true })
    },
    {
        name: 'reservation_invoice',
        description: 'Post-paid invoice data: hour statuses and amount due for compliant hours only. Executes no payment.',
        inputSchema: { type: 'object', required: ['id'], properties: { id } },
        run: (c, a) => c.invoice(a.id)
    }
];

/** Handle one JSON-RPC message; returns the response object or null for notifications. */
export async function handleMessage(msg, client) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (msg?.id === undefined || msg?.id === null) return null; // notification
    switch (msg.method) {
        case 'initialize':
            return reply({
                protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'infernet', version: CURRENT_VERSION }
            });
        case 'ping':
            return reply({});
        case 'tools/list':
            return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
        case 'tools/call': {
            const tool = TOOLS.find((t) => t.name === msg.params?.name);
            if (!tool) return fail(-32602, `unknown tool: ${msg.params?.name}`);
            try {
                const data = await tool.run(client, msg.params?.arguments ?? {});
                return reply({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
            } catch (e) {
                return reply({ isError: true, content: [{ type: 'text', text: e?.message ?? String(e) }] });
            }
        }
        default:
            return fail(-32601, `method not found: ${msg.method}`);
    }
}

export default async function mcp(args) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write('infernet mcp — MCP server (stdio) for managed-endpoint reservations\n\n  claude mcp add infernet -- infernet mcp\n');
        return 0;
    }
    const client = createReservationsClient(await resolveClientOptions({ url: args.get('url'), token: args.get('token'), buyerToken: args.get('buyer-token') }));
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch {
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
            continue;
        }
        const res = await handleMessage(msg, client);
        if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    }
    return 0;
}
