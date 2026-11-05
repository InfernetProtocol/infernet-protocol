/**
 * `infernet price` — what your node charges for the models it serves.
 *
 * A model nobody has priced is charged the network's default, so adding a
 * model is never an accidental giveaway. You can override that for your own
 * node, inside the band the network allows.
 *
 *   infernet price list [--node <pubkey>]
 *   infernet price set <model> --out <usd> [--in <usd>] [--node <pubkey>]
 *   infernet price unset <model> [--node <pubkey>]
 *
 * Prices are USD per 1M tokens. --out is the one that matters: output tokens
 * dominate what a chat costs. --in defaults to a quarter of --out, which is
 * roughly the house ratio.
 */

import { loadConfig } from '../lib/config.js';

const DEFAULT_URL = 'https://infernetprotocol.com';

const HELP = `infernet price — what your node charges per model

Usage:
  infernet price list                          Every model your node serves, and its price
  infernet price set <model> --out <usd>       Set your price (USD per 1M output tokens)
                   [--in <usd>]                Input price (default: a quarter of --out)
  infernet price unset <model>                 Fall back to the network's price
  infernet price --help

Options:
  --node <pubkey>   Which of your nodes (default: this machine's identity)
  --url <url>       Control plane (default: $INFERNET_URL or infernetprotocol.com)
  --json            Raw JSON

A model nobody has priced is charged the network default, so a new model is
never served for free. Your own price wins over the network's, as long as it
sits inside the allowed band — "infernet price list" shows the band.
`;

function fmt(n) {
    const v = Number(n) || 0;
    return v >= 0.01 ? `$${v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}` : `$${v.toFixed(6).replace(/0+$/, '')}`;
}

async function resolve(args) {
    const config = await loadConfig().catch(() => null);
    const token = args.get('token') || config?.auth?.bearerToken || null;
    if (!token) throw new Error('not signed in: run `infernet login` first');

    // This machine's node pubkey, the same one `infernet pubkey` links.
    const pubkey = args.get('node') || config?.node?.publicKey || null;
    if (!pubkey) {
        throw new Error('no node identity on this machine: pass --node <pubkey> (see `infernet pubkey`)');
    }
    const baseUrl = String(args.get('url') || process.env.INFERNET_URL || config?.controlPlane?.url || DEFAULT_URL)
        .replace(/\/+$/, '');
    return { baseUrl, token, pubkey };
}

async function call(method, { baseUrl, token, pubkey }, { path = '', body } = {}) {
    const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}/api/v1/user/nodes/${encodeURIComponent(pubkey)}/prices${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }

    // An nginx or Next error page, or a control plane mid-deploy. Never print
    // a page of HTML into someone's terminal: say what happened instead.
    if (json === null) {
        if (res.status === 404) {
            throw new Error('this control plane does not support per-node pricing yet (needs a newer infernetprotocol.com)');
        }
        throw new Error(`the control plane returned HTTP ${res.status} (not JSON); try again shortly`);
    }

    if (!res.ok) {
        const bounds = json?.bounds ? ` (allowed ${fmt(json.bounds.min)}-${fmt(json.bounds.max)} per 1M)` : '';
        throw new Error(`${json?.error ?? `HTTP ${res.status}`}${bounds}`);
    }
    return json;
}

export default async function price(args) {
    const [sub, a1] = args.positional;
    if (args.has('help') || sub === 'help') {
        process.stdout.write(HELP);
        return 0;
    }

    const ctx = await resolve(args);

    switch (sub ?? 'list') {
        case 'list': {
            const out = await call('GET', ctx);
            if (args.has('json')) {
                process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
                return 0;
            }
            const band = out.operator_pricing_enabled
                ? `your price must be ${fmt(out.bounds.min_per_m_usd)}-${fmt(out.bounds.max_per_m_usd)} per 1M tokens`
                : 'operator pricing is switched off on this network';
            process.stdout.write(`node ${ctx.pubkey.slice(0, 12)}…  (${band})\n`);
            process.stdout.write(`network default: in ${fmt(out.default_model_price.input_per_m_usd)} / out ${fmt(out.default_model_price.output_per_m_usd)} per 1M\n\n`);
            if (out.models.length === 0) {
                process.stdout.write('this node serves no models yet\n');
                return 0;
            }
            for (const m of out.models) {
                const mark = m.source === 'operator' ? 'yours ' : m.source === 'house' ? 'network' : 'default';
                const warn = m.clamped ? '  (clamped into the allowed band)' : '';
                process.stdout.write(
                    `  ${m.model}\n      in ${fmt(m.input_per_m_usd)} / out ${fmt(m.output_per_m_usd)} per 1M   [${mark}]${warn}\n`
                );
            }
            process.stdout.write('\nset yours:  infernet price set <model> --out <usd>\n');
            return 0;
        }

        case 'set': {
            if (!a1) throw new Error('usage: infernet price set <model> --out <usd> [--in <usd>]');
            const out = Number(args.get('out'));
            if (!Number.isFinite(out) || out < 0) throw new Error('--out <usd> is required: your price per 1M output tokens');
            // Output tokens dominate the bill, so --in follows --out unless
            // asked for: a quarter is roughly the house ratio.
            const inPrice = args.get('in') === undefined ? Math.round((out / 4) * 1e6) / 1e6 : Number(args.get('in'));
            if (!Number.isFinite(inPrice) || inPrice < 0) throw new Error('--in must be a non-negative number of USD per 1M tokens');

            const r = await call('PUT', ctx, {
                body: { model: a1, input_per_m_usd: inPrice, output_per_m_usd: out }
            });
            if (args.has('json')) {
                process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
                return 0;
            }
            process.stdout.write(`${r.model}: in ${fmt(r.input_per_m_usd)} / out ${fmt(r.output_per_m_usd)} per 1M tokens\n`);
            process.stdout.write('this node now charges your price for that model\n');
            return 0;
        }

        case 'unset': {
            if (!a1) throw new Error('usage: infernet price unset <model>');
            const r = await call('DELETE', ctx, { path: `?model=${encodeURIComponent(a1)}` });
            if (args.has('json')) {
                process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
                return 0;
            }
            process.stdout.write(`${r.model}: back to the network's price\n`);
            return 0;
        }

        default:
            process.stderr.write(`unknown subcommand: ${sub}\n\n${HELP}`);
            return 1;
    }
}
