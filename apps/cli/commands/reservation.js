/**
 * `infernet reservation` — managed endpoints / reservations
 * (docs/prd/16-managed-endpoints.md). Talks to /api/v1/reservations/*.
 */
import {
    resolveClientOptions, createReservationsClient, createBodyFromFlags, renderReport, renderInvoice
} from '../lib/reservations-client.js';

const HELP = `infernet reservation — managed model endpoints for resellers

A reservation pins exact model id(s) on one named operator target for whole
UTC hours, with included tokens and per-key / shared rate + concurrency
limits. Keys issued on it work against /v1/chat/completions and /v1/models.
Every minute of the window is probed; the report and invoice view are built
from those probes. Nothing is charged.

Usage:
  infernet reservation list
  infernet reservation create --name N --operator O --models m1[,m2]
        (--provider-id <node uuid> | --endpoint-url https://op.example/v1 [--endpoint-key K])
        --start 2026-10-12T15:00:00Z --hours 1 --included-tokens 2000000
        --per-key-rps 2 --per-key-concurrency 2 --shared-rps 10 --shared-concurrency 8
        [--buyer KAI] [--required-minutes 60] [--probe-completion]
        [--gpu-class l40s|a100|h100|h100x2] [--price-per-hour X] [--setup-fee X]
        [--currency USD] [--notes "..."]
        (--gpu-class prices it from the list; a lower --price-per-hour is refused)
  infernet reservation pricing                  the price list by GPU class
  infernet reservation show <id>
  infernet reservation price <id> --price-per-hour X [--currency USD]
  infernet reservation cancel <id>
  infernet reservation keys <id>
  infernet reservation key-issue <id> [--label customer-a]
  infernet reservation key-revoke <id> <keyId>
  infernet reservation report <id> [--minutes] [--json]
  infernet reservation invoice <id> [--json]
  infernet reservation buyer-token <id>        rotate the buyer's read-only token
  infernet reservation watch <id> [--every 15]  live per-hour availability view

Auth:
  admin  --token or INFERNET_ADMIN_TOKEN, else your \`infernet login\` bearer
         (its email must be in the server's INFERNET_ADMIN_EMAILS)
  buyer  --buyer-token or INFERNET_BUYER_TOKEN (one reservation: show, report,
         invoice, keys, key-issue, key-revoke)
  url    --url or INFERNET_URL (default: config control plane, else infernetprotocol.com)
`;

function out(obj) {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function needId(id) {
    if (!id) throw new Error('reservation id required (see `infernet reservation --help`)');
    return id;
}

function summary(r) {
    const target = r.target_kind === 'node' ? `node ${r.provider_id}` : r.endpoint_url;
    return `${r.id}  ${r.phase.padEnd(9)} ${r.start_at} +${r.hours}h  ${r.models.join(',')}  ${r.operator_name} (${target})${r.buyer ? `  buyer=${r.buyer}` : ''}`;
}

async function watch(client, id, everySec) {
    const tty = process.stdout.isTTY;
    let stop = false;
    process.on('SIGINT', () => { stop = true; });
    while (!stop) {
        let text;
        try {
            text = renderReport(await client.report(id), { color: tty });
        } catch (e) {
            text = `report failed: ${e.message}`;
        }
        if (tty) process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(`${text}\n\n${tty ? `refreshing every ${everySec}s — Ctrl-C to quit` : ''}\n`);
        if (!tty) return 0;
        await new Promise((r) => setTimeout(r, everySec * 1000));
    }
    return 0;
}

export default async function reservation(args) {
    const [sub, a1, a2] = args.positional;
    if (!sub || args.has('help') || args.has('h') || sub === 'help') {
        process.stdout.write(HELP);
        return sub ? 0 : (args.has('help') ? 0 : 1);
    }
    const opts = await resolveClientOptions({ url: args.get('url'), token: args.get('token'), buyerToken: args.get('buyer-token') });
    const client = createReservationsClient(opts);
    const json = args.has('json');

    switch (sub) {
        case 'list': {
            const rows = await client.list();
            if (json) return out(rows), 0;
            if (rows.length === 0) process.stdout.write('no reservations\n');
            for (const r of rows) process.stdout.write(`${summary(r)}\n`);
            return 0;
        }
        case 'create': {
            const created = await client.create(createBodyFromFlags((k) => args.get(k) ?? (args.has(k) ? true : undefined)));
            if (json) return out(created), 0;
            process.stdout.write(`created ${summary(created.reservation)}\n`);
            process.stdout.write(`buyer token (shown once — give it to the buyer):\n  ${created.buyer_token}\n`);
            process.stdout.write(`next: infernet reservation key-issue ${created.reservation.id} --label <customer>\n`);
            return 0;
        }
        case 'pricing': {
            const list = await client.pricing();
            if (json) return out(list), 0;
            process.stdout.write(`${list.currency} ${list.basis}\nsetup fee: ${list.setup_fee}\n\n`);
            for (const t of list.tiers) {
                process.stdout.write(`${t.gpu_class.padEnd(7)} ${t.label.padEnd(13)} $${t.price_per_hour.toFixed(2)}/hr  setup $${t.setup_fee.toFixed(2)}  ${t.fits}\n`);
            }
            return 0;
        }
        case 'show': {
            const r = await client.get(needId(a1));
            return out(r), 0;
        }
        case 'price': {
            const patch = { price_per_hour: args.get('price-per-hour') === 'null' ? null : Number(args.get('price-per-hour')) };
            if (args.get('currency')) patch.currency = args.get('currency');
            if (args.get('price-per-hour') === undefined) throw new Error('--price-per-hour is required');
            return out(await client.update(needId(a1), patch)), 0;
        }
        case 'cancel':
            return out(await client.cancel(needId(a1))), 0;
        case 'keys': {
            const keys = await client.listKeys(needId(a1));
            if (json) return out(keys), 0;
            for (const k of keys) process.stdout.write(`${k.id}  ${k.key_prefix}…  ${k.label ?? ''}  ${k.revoked_at ? `revoked ${k.revoked_at}` : 'active'}\n`);
            if (keys.length === 0) process.stdout.write('no keys\n');
            return 0;
        }
        case 'key-issue': {
            const k = await client.issueKey(needId(a1), args.get('label'));
            if (json) return out(k), 0;
            process.stdout.write(`key ${k.id}${k.label ? ` (${k.label})` : ''} — shown once:\n  ${k.key}\n`);
            return 0;
        }
        case 'key-revoke':
            if (!a2) throw new Error('usage: infernet reservation key-revoke <id> <keyId>');
            return out(await client.revokeKey(needId(a1), a2)), 0;
        case 'report': {
            const rep = await client.report(needId(a1), { minutes: args.has('minutes') });
            if (json || args.has('minutes')) return out(rep), 0;
            process.stdout.write(`${renderReport(rep, { color: process.stdout.isTTY })}\n`);
            return 0;
        }
        case 'invoice': {
            const inv = await client.invoice(needId(a1));
            if (json) return out(inv), 0;
            process.stdout.write(`${renderInvoice(inv)}\n`);
            return 0;
        }
        case 'buyer-token': {
            const r = await client.rotateBuyerToken(needId(a1));
            process.stdout.write(`new buyer token (the old one no longer works):\n  ${r.buyer_token}\n`);
            return 0;
        }
        case 'watch':
            return watch(client, needId(a1), Math.max(5, Number(args.get('every') ?? 15) || 15));
        default:
            process.stderr.write(`unknown subcommand: ${sub}\n\n${HELP}`);
            return 1;
    }
}
