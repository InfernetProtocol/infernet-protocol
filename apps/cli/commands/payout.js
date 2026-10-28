/**
 * `infernet payout` — earnings, withdrawals and the payout address, via the
 * signed node API.
 *
 * Subcommands:
 *   infernet payout list                       balance, recent credits, withdrawals, addresses
 *   infernet payout set <coin> <address> [--network <name>]
 *   infernet payout request [--amount <usd>]   withdraw (queued for admin approval)
 *   infernet payout admin list|approve|reject|settings   (INFERNET_ADMIN_TOKEN)
 */

import { PAYMENT_COINS, PAYMENT_COIN_CODES } from '@infernetprotocol/config/payment-coins';
import { resolveClientOptions } from '../lib/reservations-client.js';

const HELP = `infernet payout — earnings, withdrawals and payout address

Usage:
  infernet payout list                         Balance, recent credits, withdrawals, addresses
  infernet payout set <coin> <address> [--network <name>]
  infernet payout request [--amount <usd>]     Withdraw (default: whole available balance)
  infernet payout --help

Every completed job credits your node. Free (playground) jobs earn a house
subsidy per 1k output tokens, "pending approval" until the rate is approved;
paid jobs earn your share of the client's payment once it is confirmed.
Earnings accrue with or without a payout address: you only need one to
withdraw. Withdrawals are sent through CoinPay after approval; small ones
(up to the network's auto-approve amount) go out as soon as you ask.

Admin (needs INFERNET_ADMIN_TOKEN or --token):
  infernet payout admin list [--status requested|sending|sent|all]
  infernet payout admin approve <request-id>   SENDS REAL FUNDS via CoinPay
  infernet payout admin reject <request-id> [--reason <text>]
  infernet payout admin mark-sent <request-id> --tx <hash>
  infernet payout admin mark-failed <request-id>
  infernet payout admin settings [--rate <usd per 1k>] [--fee <pct>] [--min <usd>]
                               [--auto-approve-max <usd>] [--approve-subsidy]

Or sign in to the website with the admin account and use /admin/payouts.

Supported coins: ${PAYMENT_COIN_CODES.join(', ')}
`;

/** Sub-cent credits must not print as $0.00. */
export function fmtUsd(n) {
    const v = Number(n) || 0;
    if (v === 0) return '$0.00';
    if (Math.abs(v) >= 0.01) return `$${v.toFixed(2)}`;
    return `$${v.toFixed(6).replace(/0+$/, '')}`;
}

const STATUS_LABEL = {
    pending_approval: 'pending approval',
    pending: 'awaiting client payment',
    confirmed: 'confirmed',
    void: 'void'
};

export function formatBalance(b = {}) {
    return [
        `Earnings:   ${fmtUsd(b.pending_approval_usd)} pending approval, ${fmtUsd(b.pending_usd)} awaiting client payment, ${fmtUsd(b.confirmed_usd)} confirmed`,
        `Payouts:    ${fmtUsd(b.paid_usd)} paid, ${fmtUsd(b.requested_usd)} requested, ${fmtUsd(b.available_usd)} available to withdraw`,
        `Jobs:       ${b.jobs_credited ?? 0} credited`
    ].join('\n');
}

function pickNetwork(coin, requestedNetwork) {
    const upper = String(coin).toUpperCase();
    const matches = PAYMENT_COINS.filter((c) => c.code === upper);
    if (matches.length === 0) return null;
    if (requestedNetwork) {
        const hit = matches.find((c) => c.network === requestedNetwork);
        return hit ? hit.network : null;
    }
    return matches[0].network;
}

async function runList(args, ctx) {
    const { config, client } = ctx;
    const node = config.node ?? {};
    if (node.role !== 'provider') {
        process.stderr.write('Payouts are only configurable for providers.\n');
        return 1;
    }

    let earnings = null;
    try {
        earnings = await client.earnings(Number.parseInt(args.get('limit') ?? '10', 10) || 10);
    } catch (err) {
        process.stderr.write(`earnings lookup failed: ${err?.message ?? err}\n`);
    }
    let result;
    try {
        result = await client.listPayouts();
    } catch (err) {
        process.stderr.write(`payout list failed: ${err?.message ?? err}\n`);
        return 1;
    }

    if (args.has('json')) {
        process.stdout.write(JSON.stringify({ earnings, addresses: result?.rows ?? [] }, null, 2) + '\n');
        return 0;
    }

    if (earnings) {
        const cfg = earnings.config ?? {};
        process.stdout.write(formatBalance(earnings.balance) + '\n');
        process.stdout.write(
            `Rates:      free jobs ${fmtUsd(cfg.subsidy_per_1k_output_usd)}/1k output tokens` +
            `${cfg.subsidy_approved ? '' : ' (pending approval)'}, house fee on paid jobs ${cfg.house_fee_pct ?? 0}%, ` +
            `minimum withdrawal ${fmtUsd(cfg.min_payout_usd)}\n`
        );
        const recent = earnings.recent ?? [];
        if (recent.length) {
            process.stdout.write('\nRecent credits:\n');
            for (const e of recent) {
                const when = String(e.earned_at ?? '').replace('T', ' ').slice(0, 16);
                process.stdout.write(
                    `  ${when}  ${String(e.job_id).slice(0, 8)}  ${(e.model_name ?? '-').padEnd(18)} ` +
                    `${String(e.output_tokens ?? 0).padStart(6)} tok  ${fmtUsd(e.amount_usd).padStart(11)}  ` +
                    `${e.kind}  ${STATUS_LABEL[e.status] ?? e.status}\n`
                );
            }
        }
        const payouts = earnings.payouts ?? [];
        if (payouts.length) {
            process.stdout.write('\nWithdrawals:\n');
            for (const p of payouts) {
                process.stdout.write(
                    `  ${String(p.created_at).slice(0, 10)}  ${fmtUsd(p.amount_usd)}  ${p.coin}  ${p.status}` +
                    `${p.tx_hash ? `  tx ${p.tx_hash}` : ''}${p.status === 'rejected' && p.error ? `  (${p.error})` : ''}\n`
                );
            }
        }
        process.stdout.write('\n');
    }

    const rows = result?.rows ?? [];
    if (!rows.length) {
        process.stdout.write('(no payout addresses configured: earnings still accrue)\n');
        process.stdout.write('Use `infernet payout set <coin> <address>` before you withdraw.\n');
        return 0;
    }
    process.stdout.write('Payout addresses:\n');
    for (const row of rows) {
        const marker = row.is_default ? '* ' : '  ';
        const net = row.network ? ` (${row.network})` : '';
        process.stdout.write(`${marker}${row.coin}${net}  ${row.address}\n`);
    }
    return 0;
}

async function runRequest(args, ctx) {
    const { config, client } = ctx;
    if ((config.node?.role) !== 'provider') {
        process.stderr.write('Payouts are only available to providers.\n');
        return 1;
    }
    const raw = args.get('amount');
    const amount = raw == null || raw === true ? null : Number(raw);
    if (amount !== null && !(amount > 0)) {
        process.stderr.write('--amount must be a positive USD amount\n');
        return 1;
    }
    try {
        const out = await client.requestPayout(amount);
        const r = out?.request ?? {};
        const to = `${r.coin}${r.network ? ` (${r.network})` : ''} ${r.address}`;
        if (r.status === 'sent') {
            process.stdout.write(`Sent ${fmtUsd(r.amount_usd)} to ${to}.\ntx ${r.tx_hash}\n`);
            return 0;
        }
        process.stdout.write(
            `Requested ${fmtUsd(r.amount_usd)} to ${to}.\n` +
            `Request ${r.id} is ${r.status === 'sending' ? 'being sent' : 'waiting for approval'}; \`infernet payout list\` shows its status.\n`
        );
        return 0;
    } catch (err) {
        process.stderr.write(`payout request failed: ${err?.body?.error ?? err?.message ?? err}\n`);
        return 1;
    }
}

async function adminCall(opts, method, path, body) {
    const { baseUrl, adminToken } = await resolveClientOptions(opts);
    if (!adminToken) throw new Error('set INFERNET_ADMIN_TOKEN (or pass --token)');
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${adminToken}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${json?.error ?? text.slice(0, 200)}`);
    return json?.data ?? json;
}

async function runAdmin(args, positional) {
    const [action, id] = positional;
    const opts = {
        url: args.get('url') === true ? undefined : args.get('url'),
        token: args.get('token') === true ? undefined : args.get('token')
    };
    const enc = encodeURIComponent;
    try {
        if (!action || action === 'list') {
            const status = args.get('status') && args.get('status') !== true ? args.get('status') : 'requested';
            const data = await adminCall(opts, 'GET', `/api/v1/admin/payouts?status=${enc(status)}`);
            if (args.has('json')) {
                process.stdout.write(JSON.stringify(data, null, 2) + '\n');
                return 0;
            }
            const t = data?.totals ?? {};
            const tot = t.totals_usd ?? {};
            process.stdout.write(
                `Ledger: ${t.credits ?? 0} credits, ${t.providers ?? 0} providers; subsidy ${fmtUsd(tot['subsidy:pending_approval'])} pending approval, ` +
                `${fmtUsd(tot['subsidy:confirmed'])} confirmed; paid jobs ${fmtUsd(tot['paid:pending'])} pending, ${fmtUsd(tot['paid:confirmed'])} confirmed\n`
            );
            const c = t.config ?? {};
            process.stdout.write(
                `Config: subsidy ${fmtUsd(c.subsidy_per_1k_output_usd)}/1k (${c.subsidy_approved ? 'approved' : 'NOT approved'}), fee ${c.house_fee_pct}%, minimum ${fmtUsd(c.min_payout_usd)}, ` +
                `auto-approve ${Number(c.auto_approve_max_usd) > 0 ? `up to ${fmtUsd(c.auto_approve_max_usd)}` : 'off'}\n\n`
            );
            const rows = data?.rows ?? [];
            if (!rows.length) {
                process.stdout.write(`(no ${status} payout requests)\n`);
                return 0;
            }
            for (const r of rows) {
                process.stdout.write(
                    `${r.id}  ${String(r.created_at).slice(0, 16)}  ${(r.provider_name ?? r.provider_id).slice(0, 32).padEnd(32)}  ` +
                    `${fmtUsd(r.amount_usd).padStart(10)}  ${r.coin}${r.network ? `/${r.network}` : ''} ${r.address}  ${r.status}` +
                    `${r.error ? `  (${r.error})` : ''}\n`
                );
            }
            return 0;
        }
        if (action === 'settings') {
            const body = {};
            if (args.get('rate') != null) body.subsidy_per_1k_output_usd = Number(args.get('rate'));
            if (args.get('fee') != null) body.house_fee_pct = Number(args.get('fee'));
            if (args.get('min') != null) body.min_payout_usd = Number(args.get('min'));
            if (args.get('auto-approve-max') != null) body.auto_approve_max_usd = Number(args.get('auto-approve-max'));
            if (args.has('approve-subsidy')) body.subsidy_approved = true;
            if (args.has('unapprove-subsidy')) body.subsidy_approved = false;
            const data = Object.keys(body).length
                ? await adminCall(opts, 'POST', '/api/v1/admin/earnings/settings', body)
                : await adminCall(opts, 'GET', '/api/v1/admin/earnings/settings');
            process.stdout.write(JSON.stringify(data, null, 2) + '\n');
            return 0;
        }
        const actions = { approve: 'approve', reject: 'reject', 'mark-sent': 'mark_sent', 'mark-failed': 'mark_failed' };
        if (!actions[action]) {
            process.stderr.write(`Unknown payout admin action "${action}".\n`);
            return 1;
        }
        if (!id) {
            process.stderr.write(`Usage: infernet payout admin ${action} <request-id>\n`);
            return 1;
        }
        const body = { action: actions[action] };
        if (action === 'reject' && args.get('reason') && args.get('reason') !== true) body.reason = args.get('reason');
        if (action === 'mark-sent') {
            const tx = args.get('tx');
            if (!tx || tx === true) {
                process.stderr.write('mark-sent needs --tx <hash>\n');
                return 1;
            }
            body.tx_hash = tx;
        }
        const data = await adminCall(opts, 'POST', `/api/v1/admin/payouts/${enc(id)}`, body);
        const r = data?.request ?? {};
        process.stdout.write(`${r.id}: ${r.status}${data?.outcome ? ` (outcome ${data.outcome})` : ''}${r.tx_hash ? ` tx ${r.tx_hash}` : ''}${r.error ? ` ${r.error}` : ''}\n`);
        return r.status === 'failed' || data?.outcome === 'not_sent' ? 1 : 0;
    } catch (err) {
        process.stderr.write(`payout admin ${action ?? 'list'} failed: ${err?.message ?? err}\n`);
        return 1;
    }
}

async function runSet(args, ctx, positional) {
    const [coinArg, addressArg] = positional;
    if (!coinArg || !addressArg) {
        process.stderr.write('Usage: infernet payout set <coin> <address> [--network <name>]\n');
        return 1;
    }
    const coin = coinArg.toUpperCase();
    if (!PAYMENT_COIN_CODES.includes(coin)) {
        process.stderr.write(
            `Unsupported coin "${coin}". Supported: ${PAYMENT_COIN_CODES.join(', ')}\n`
        );
        return 1;
    }
    const requestedNetwork = args.get('network');
    const network = pickNetwork(coin, requestedNetwork);
    if (!network) {
        process.stderr.write(
            `Coin "${coin}" has no network "${requestedNetwork}". Check config/payment-coins.js.\n`
        );
        return 1;
    }

    const { config, client } = ctx;
    if ((config.node?.role) !== 'provider') {
        process.stderr.write('Payouts are only configurable for providers.\n');
        return 1;
    }

    try {
        await client.setPayout({ coin, network, address: addressArg });
    } catch (err) {
        process.stderr.write(`payout set failed: ${err?.message ?? err}\n`);
        return 1;
    }
    process.stdout.write(`Set default payout: ${coin} (${network}) ${addressArg}\n`);
    return 0;
}

export default async function payout(args, ctx) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }

    const positional = args.positional ?? [];
    const sub = positional[0];

    if (!sub) {
        process.stderr.write(HELP);
        return 1;
    }

    const rest = positional.slice(1);

    switch (sub) {
        case 'list':
            return runList(args, ctx);
        case 'set':
            return runSet(args, ctx, rest);
        case 'request':
        case 'withdraw':
            return runRequest(args, ctx);
        case 'admin':
            return runAdmin(args, rest);
        default:
            process.stderr.write(`Unknown payout subcommand "${sub}".\n`);
            process.stderr.write(HELP);
            return 1;
    }
}

export { HELP };
