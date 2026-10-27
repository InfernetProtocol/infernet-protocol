/**
 * `infernet order` — book a managed endpoint yourself, no admin
 * (docs/prd/16-managed-endpoints.md, "Self-serve orders"). Talks to /api/v1/orders/*.
 */
import { resolveClientOptions } from '../lib/reservations-client.js';
import { createOrdersClient, orderBodyFromFlags, x402KeyFrom, DEFAULT_MAX_USD } from '../lib/orders-client.js';

const HELP = `infernet order — order a dedicated model endpoint by the hour

We pin the models on one online node with the GPU class you pick, for the
hours you book, and you get an OpenAI-compatible API key. Prepaid at the quoted
price; non-compliant hours are credited or refunded.

Usage:
  infernet order capacity                  what is on sale now: classes, prices, free nodes, models
  infernet order quote  --gpu l40s --models m1[,m2] [--hours 1] [--start 2026-10-28T15:00:00Z]
  infernet order create --gpu l40s --models m1[,m2] [--hours 1] [--start ISO] [--email you@x]
        --checkout                 pay at CoinPay (any coin or PayPal): prints the checkout URL
        --x402                     pay now in USDC from X402_PRIVATE_KEY (or --key-file F)
              [--max-usd ${DEFAULT_MAX_USD}]        refuse to sign more than this
  infernet order status <id> --buyer-token ifr_buy_…   (or INFERNET_BUYER_TOKEN)

Admin (INFERNET_ADMIN_TOKEN or --token):
  infernet order margin [PCT]              show / set the minimum profit margin over our
                                           GPU cost, 1-2000 (default 100 = twice our cost)

After booking, manage it with \`infernet reservation\` and the same buyer token:
  INFERNET_BUYER_TOKEN=ifr_buy_… infernet reservation key-issue <reservation id>
`;

function out(obj) {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function line(o) {
    return `${o.id}  ${o.status.padEnd(16)} ${o.gpu_class} ${o.models.join(',')} ${o.start_at} +${o.hours}h  $${Number(o.total_usd).toFixed(2)}  ${o.operator_name}`;
}

export default async function order(args) {
    const [sub, a1] = args.positional;
    if (!sub || args.has('help') || args.has('h') || sub === 'help') {
        process.stdout.write(HELP);
        return sub || args.has('help') ? 0 : 1;
    }
    const { baseUrl, adminToken } = await resolveClientOptions({ url: args.get('url'), token: args.get('token') });
    const client = createOrdersClient({ baseUrl });
    const json = args.has('json');
    const body = () => orderBodyFromFlags((k) => args.get(k));

    switch (sub) {
        case 'capacity': {
            const c = await client.capacity();
            if (json) return out(c), 0;
            process.stdout.write(`${c.terms}\nearliest start ${c.earliest_start}, up to ${c.max_hours}h; pay: x402=${c.pay.x402} checkout=${c.pay.checkout}\n\n`);
            for (const k of c.classes) {
                process.stdout.write(`${k.gpu_class.padEnd(7)} ${k.label.padEnd(13)} $${k.price_per_hour.toFixed(2)}/hr + $${k.setup_fee.toFixed(2)} setup  ${String(k.nodes_available).padStart(2)} free  ${k.models.join(', ') || '—'}\n`);
            }
            return 0;
        }
        case 'quote': {
            const q = await client.quote(body());
            if (json) return out(q), 0;
            const s = q.quote;
            process.stdout.write(`${s.label} x ${s.hours}h from ${s.start_at}: $${s.total_usd.toFixed(2)} ($${s.price_per_hour}/h + $${s.setup_fee} setup) on ${s.operator_name}\n`);
            process.stdout.write(`x402: ${q.accepts.map((a) => a.network).join(', ')}  |  or: infernet order create ... --checkout\n`);
            return 0;
        }
        case 'create': {
            if (args.has('x402') === args.has('checkout')) throw new Error('pick one: --checkout (CoinPay page) or --x402 (pay now in USDC)');
            if (args.has('checkout')) {
                const r = await client.checkout(body());
                if (json) return out(r), 0;
                process.stdout.write(`order ${line(r.order)}\n`);
                process.stdout.write(`pay here: ${r.checkout_url}\n`);
                process.stdout.write(`buyer token (shown once, keep it):\n  ${r.buyer_token}\n`);
                process.stdout.write(`then: infernet order status ${r.order.id} --buyer-token ${r.buyer_token}\n`);
                return 0;
            }
            const key = x402KeyFrom({ keyFile: args.get('key-file') });
            const r = await client.payX402(body(), { key, maxUsd: args.get('max-usd') ?? DEFAULT_MAX_USD });
            if (json) return out(r), 0;
            process.stdout.write(`paid $${r.paid_usd} from ${r.payer} on ${r.network}${r.tx_hash ? ` (tx ${r.tx_hash})` : ''}\n`);
            process.stdout.write(`order ${line(r.order)}\nreservation ${r.reservation?.id}\n`);
            process.stdout.write(`buyer token (shown once):\n  ${r.buyer_token}\napi key (shown once):\n  ${r.api_key}\n`);
            process.stdout.write(`use: ${r.use.base_url}/chat/completions with Authorization: Bearer <api key>\n`);
            return 0;
        }
        case 'status': {
            if (!a1) throw new Error('usage: infernet order status <id> --buyer-token ifr_buy_…');
            const token = args.get('buyer-token') || process.env.INFERNET_BUYER_TOKEN;
            if (!token) throw new Error('--buyer-token (or INFERNET_BUYER_TOKEN) is required');
            const o = await client.status(a1, token);
            if (json) return out(o), 0;
            process.stdout.write(`${line(o)}\n`);
            if (o.reservation_id) process.stdout.write(`reservation ${o.reservation_id}: INFERNET_BUYER_TOKEN=… infernet reservation key-issue ${o.reservation_id}\n`);
            return 0;
        }
        case 'margin': {
            if (!adminToken) throw new Error('set INFERNET_ADMIN_TOKEN (or pass --token)');
            const v = await client.margin(adminToken, a1 === undefined ? undefined : Number(a1));
            if (json) return out(v), 0;
            process.stdout.write(`minimum profit margin ${v.min_margin_pct}% over our cost (range ${v.range.min}-${v.range.max}%)\n`);
            for (const c of v.classes) {
                process.stdout.write(`${c.gpu_class.padEnd(7)} ${c.label.padEnd(13)} cost $${c.cost_per_hour.toFixed(2)}/h  sells $${c.price_per_hour.toFixed(2)}/h + $${c.setup_fee.toFixed(2)} setup\n`);
            }
            return 0;
        }
        default:
            process.stderr.write(`unknown subcommand: ${sub}\n\n${HELP}`);
            return 1;
    }
}
