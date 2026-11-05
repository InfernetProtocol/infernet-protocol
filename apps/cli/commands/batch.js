/**
 * `infernet batch` / `infernet billing` / `infernet keys` — paid batch
 * inference on the network. Talks to /api/v1/batches/*, /api/v1/billing/*
 * and /api/v1/keys.
 */
import { randomUUID } from 'node:crypto';
import { resolveBatchOptions, createBatchClient, readBatchFile, formatBillingBalance } from '../lib/batch-client.js';

export const BATCH_HELP = `infernet batch — paid batch inference

Many chat requests in one job, prepaid, priced per token. The server holds the
most the batch can cost up front (input estimate + max_tokens x output price),
charges each item what it really produced and releases the rest. Token counts
are server-side estimates: ceil(characters / 4).

Input: a JSONL file, one request per line:
  {"custom_id":"q1","messages":[{"role":"user","content":"hi"}],"max_tokens":256}

Usage:
  infernet batch quote  <file.jsonl> --model qwen2.5:7b        max cost, no spend
  infernet batch submit <file.jsonl> --model qwen2.5:7b --max-cost 2.50
        [--funding earned_first|prepaid_first|earned_only|prepaid_only|no_wallet]
        [--idempotency-key K]   default: a new uuid (printed; reuse it to retry safely)
  infernet batch status  <batch id>
  infernet batch results <batch id> [--out file.jsonl]
  infernet batch receipt <batch id>
  infernet batch cancel  <batch id>

Auth: INFERNET_API_KEY=ik_live_... (infernet keys create) or \`infernet login\`.
Options: --json, --url <base>, --key <ik_live_...>
`;

export const BILLING_HELP = `infernet billing — the balance batch inference spends

Usage:
  infernet billing balance                 earned (node earnings), prepaid, holds
  infernet billing topup <usd>             CoinPay checkout URL (any coin or PayPal)
  infernet billing topup-status <id>       credited once CoinPay confirms payment
  infernet billing funding earned,prepaid,wallet    set your default funding order
  infernet billing spend-earnings [usd|all]  move node earnings into the balance,
                                           so they pay for chat and the API too

Earned = your confirmed node earnings (c0mpute and Infernet nodes are one
balance), spendable on compute with no fee; whatever you do not spend stays
withdrawable with \`infernet payout\`.
`;

export const KEYS_HELP = `infernet keys — API keys for the batch API (needs \`infernet login\`)

Usage:
  infernet keys create [--name <label>]    prints the key once
  infernet keys list
  infernet keys revoke <key id>
`;

async function client(args) {
    return createBatchClient(await resolveBatchOptions({ url: args.get('url'), key: args.get('key'), token: args.get('token') }));
}

function out(args, data, text) {
    process.stdout.write(args.has('json') ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
}

function batchLine(b) {
    const c = b.counts ?? {};
    return `${b.id}  ${b.status}${b.cancelling ? ' (cancelling)' : ''}  ${b.model}  ${c.completed ?? 0}/${c.total ?? 0} done, ${c.failed ?? 0} failed, ${c.queued ?? 0} queued  cost $${b.cost_so_far_usd} of max $${b.max_cost_usd}`;
}

export async function batch(args) {
    const [sub, a1] = args.positional;
    if (!sub || args.has('help') || sub === 'help') {
        process.stdout.write(BATCH_HELP);
        return sub || args.has('help') ? 0 : 1;
    }
    const c = await client(args);
    switch (sub) {
        case 'quote': {
            if (!a1 || !args.get('model')) throw new Error('usage: infernet batch quote <file.jsonl> --model <model>');
            const q = await c.quote({ model: args.get('model'), items: readBatchFile(a1) });
            out(args, q, `${q.item_count} items on ${q.model}: at most $${q.total_max_cost_usd} (input ~${q.estimated_input_tokens} tokens, up to ${q.max_output_tokens} output)\nquote ${q.quote_id}, valid until ${q.expires_at}\n${q.token_counts}`);
            return 0;
        }
        case 'submit': {
            if (!a1 || !args.get('model')) throw new Error('usage: infernet batch submit <file.jsonl> --model <model> --max-cost <usd>');
            const maxCost = args.get('max-cost');
            if (!maxCost) throw new Error('--max-cost <usd> is required: the most this batch may cost');
            const key = args.get('idempotency-key') || randomUUID();
            const body = { model: args.get('model'), items: readBatchFile(a1), max_cost_usd: String(maxCost), idempotency_key: key };
            if (args.get('funding')) body.funding = args.get('funding');
            try {
                const b = await c.submit(body);
                out(args, { ...b, idempotency_key: key }, `${batchLine(b)}\nidempotency key ${key}\nthen: infernet batch status ${b.id}`);
                return 0;
            } catch (err) {
                if (err.status === 402 && err.body) {
                    const x = err.body;
                    process.stderr.write(`${x.error}: need $${x.needed_usd}, short $${x.shortfall_usd} (earned $${x.earned_spendable_usd}, prepaid $${x.prepaid_available_usd})\n`);
                    process.stderr.write(`top up: infernet billing topup <usd>, then retry with --idempotency-key ${key}\n`);
                    return 1;
                }
                throw err;
            }
        }
        case 'status': {
            if (!a1) throw new Error('usage: infernet batch status <batch id>');
            const b = await c.status(a1);
            out(args, b, batchLine(b));
            return 0;
        }
        case 'results': {
            if (!a1) throw new Error('usage: infernet batch results <batch id>');
            const text = await c.results(a1);
            if (args.get('out')) {
                const { writeFileSync } = await import('node:fs');
                writeFileSync(args.get('out'), text);
                process.stdout.write(`wrote ${text.split('\n').filter(Boolean).length} lines to ${args.get('out')}\n`);
            } else {
                process.stdout.write(text);
            }
            return 0;
        }
        case 'receipt': {
            if (!a1) throw new Error('usage: infernet batch receipt <batch id>');
            const r = await c.receipt(a1);
            out(args, r, [
                `batch ${r.batch_id}  ${r.model}  ${r.status}`,
                `items ${r.items.completed}/${r.items.total} completed, ${r.items.failed} failed, ${r.items.cancelled} cancelled`,
                `estimated tokens: ${r.estimated_input_tokens} in, ${r.estimated_output_tokens} out at $${r.price.input_per_m_usd}/$${r.price.output_per_m_usd} per 1M`,
                `charged $${r.total_charged_usd} (provider $${r.provider_share_usd}, platform $${r.platform_fee_usd}); released $${r.released_usd}`,
                `paid from: earned $${r.funding.paid_from.earned_usd}, prepaid $${r.funding.paid_from.prepaid_usd}, wallet $${r.funding.paid_from.wallet_usd}; returned to earnings $${r.funding.returned_to_earnings_usd}`
            ].join('\n'));
            return 0;
        }
        case 'cancel': {
            if (!a1) throw new Error('usage: infernet batch cancel <batch id>');
            const r = await c.cancel(a1);
            out(args, r, `cancelled ${r.cancelled_items} queued items\n${batchLine(r.batch)}`);
            return 0;
        }
        default:
            process.stderr.write(`unknown subcommand: ${sub}\n\n${BATCH_HELP}`);
            return 1;
    }
}

export async function billing(args) {
    const [sub, a1] = args.positional;
    if (args.has('help') || sub === 'help') {
        process.stdout.write(BILLING_HELP);
        return 0;
    }
    const c = await client(args);
    switch (sub ?? 'balance') {
        case 'balance': {
            const b = await c.balance();
            out(args, b, formatBillingBalance(b));
            return 0;
        }
        case 'topup': {
            if (!a1) throw new Error('usage: infernet billing topup <usd>');
            const t = await c.topup(a1);
            out(args, t, `pay here: ${t.checkout_url}\nthen: infernet billing topup-status ${t.topup.id}`);
            return 0;
        }
        case 'topup-status': {
            if (!a1) throw new Error('usage: infernet billing topup-status <id>');
            const t = await c.topupStatus(a1);
            out(args, t, `top-up ${t.id}: ${t.status} $${t.amount_usd}${t.credited ? ' (credited now)' : ''}`);
            return 0;
        }
        case 'spend-earnings':
        case 'fund-from-earnings': {
            const r = await c.fundFromEarnings(a1 ?? 'all');
            out(args, r, `moved $${r.moved_usd} of node earnings into the compute balance\n`
                + `spendable now: $${r.balance.total_spendable_usd}\n`
                + 'it pays for inference from here on, and can no longer be withdrawn');
            return 0;
        }
        case 'funding': {
            if (!a1) throw new Error('usage: infernet billing funding earned,prepaid,wallet');
            const r = await c.setFunding(String(a1).split(',').map((s) => s.trim()).filter(Boolean));
            out(args, r, `funding order: ${r.funding_order.join(' > ')}`);
            return 0;
        }
        default:
            process.stderr.write(`unknown subcommand: ${sub}\n\n${BILLING_HELP}`);
            return 1;
    }
}

export async function keys(args) {
    const [sub, a1] = args.positional;
    if (args.has('help') || sub === 'help') {
        process.stdout.write(KEYS_HELP);
        return 0;
    }
    const c = await client(args);
    switch (sub ?? 'list') {
        case 'create': {
            const k = await c.createKey(args.get('name'));
            out(args, k, `API key (shown once, keep it):\n  ${k.key}\nid ${k.id}\nuse: export INFERNET_API_KEY=${k.key}`);
            return 0;
        }
        case 'list': {
            const rows = await c.listKeys();
            out(args, rows, rows.length
                ? rows.map((k) => `${k.id}  ${k.prefix}…  ${k.name ?? ''}  ${k.revoked_at ? 'revoked' : `last used ${k.last_used_at ?? 'never'}`}`).join('\n')
                : 'No keys. infernet keys create');
            return 0;
        }
        case 'revoke': {
            if (!a1) throw new Error('usage: infernet keys revoke <key id>');
            const k = await c.revokeKey(a1);
            out(args, k, `revoked ${k.id} (${k.prefix}…)`);
            return 0;
        }
        default:
            process.stderr.write(`unknown subcommand: ${sub}\n\n${KEYS_HELP}`);
            return 1;
    }
}

export default batch;
