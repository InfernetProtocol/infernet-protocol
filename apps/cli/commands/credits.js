/**
 * `infernet credits` / `infernet redeem` / `infernet invites` — consumer
 * compute credits and scarce invites for a signed-in account (`infernet login`).
 *
 * Credits are what you hold as a CUSTOMER of the network. They are separate
 * from node earnings (`infernet payout`) and can never be withdrawn.
 */
import { resolveCreditsOptions, createCreditsClient } from '../lib/credits-client.js';

export const CREDITS_HELP = `infernet credits — consumer compute credits

Usage:
  infernet credits                         Balance and recent grants
  infernet credits redeem <code>           Redeem a credit code (also: infernet redeem <code>)
  infernet invites                         Your invites, quota and affiliate link
  infernet invites create [--note <text>]  Create an invite (the code is shown once)
  infernet invites revoke <invite-id>      Withdraw an unused invite
  infernet invites accept <code>           Join on an invite (new accounts only)

Admin (INFERNET_ADMIN_TOKEN or an admin login):
  infernet credits admin list
  infernet credits admin mint --credits <n> [--label <text>] [--max <n>] [--expires <iso>] [--monthly]
  infernet credits admin revoke <code-id>

Options: --json, --url <base>, --token <bearer>
Credits are not node earnings and cannot be withdrawn (see \`infernet payout\`).
`;

async function client(args) {
    return createCreditsClient(await resolveCreditsOptions({ url: args.get('url'), token: args.get('token') }));
}

function out(args, data, text) {
    process.stdout.write(args.has('json') ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
}

export async function redeemCode(args, code) {
    if (!code) {
        process.stderr.write('Usage: infernet redeem <code>\n');
        return 1;
    }
    const c = await client(args);
    try {
        const r = await c.redeem(code);
        out(args, r, `Redeemed: +${r.credits} credits${r.monthly ? ' every month' : ''}. Balance: ${r.balance}`);
        return 0;
    } catch (err) {
        process.stderr.write(`${err.message}\n`);
        return 1;
    }
}

export async function credits(args) {
    const [sub, ...rest] = args.positional;
    if (args.has('help') || args.has('h') || sub === 'help') {
        process.stdout.write(CREDITS_HELP);
        return 0;
    }
    if (sub === 'redeem') return redeemCode(args, rest[0]);
    const c = await client(args);
    if (sub === 'admin') {
        const [action, arg] = rest;
        if (action === 'list') {
            const rows = await c.listCodes();
            out(args, rows, rows.length
                ? rows.map((r) => `${r.id}  ${r.grant.amount} ${r.grant.unit}${r.grant.every ? '/month' : ''}  ${r.redemptions}/${r.maxRedemptions}${r.revokedAt ? '  revoked' : ''}  ${r.label}`).join('\n')
                : 'No codes.');
            return 0;
        }
        if (action === 'mint') {
            const body = {
                credits: Number(args.get('credits') ?? args.get('amount')),
                label: args.get('label'),
                max_redemptions: args.get('max') ? Number(args.get('max')) : undefined,
                expires_at: args.get('expires'),
                monthly: args.has('monthly')
            };
            const r = await c.mintCode(body);
            out(args, r, `Code: ${r.code}\n(shown once; only its hash is stored)  id ${r.id}  ${r.grant.amount} credits${r.grant.every ? '/month' : ''}  max ${r.maxRedemptions}`);
            return 0;
        }
        if (action === 'revoke' && arg) {
            out(args, await c.revokeCode(arg), `Revoked ${arg}.`);
            return 0;
        }
        process.stderr.write(CREDITS_HELP);
        return 1;
    }
    if (sub && sub !== 'balance') {
        process.stderr.write(CREDITS_HELP);
        return 1;
    }
    const s = await c.balance();
    const lines = [`Credits: ${s.balance}`];
    for (const h of (s.history ?? []).slice(0, 10)) lines.push(`  ${h.kind === 'spend' ? '-' : '+'}${h.amount}  ${h.source}  ${String(h.at).slice(0, 10)}`);
    out(args, s, lines.join('\n'));
    return 0;
}

export async function invites(args) {
    const [sub, arg] = args.positional;
    if (args.has('help') || args.has('h') || sub === 'help') {
        process.stdout.write(CREDITS_HELP);
        return 0;
    }
    const c = await client(args);
    try {
        if (sub === 'create') {
            const r = await c.createInvite(args.get('note') ?? '');
            out(args, r, `Invite: ${r.url}\n(code ${r.code}, shown once; expires ${String(r.expiresAt ?? '').slice(0, 10)})`);
            return 0;
        }
        if (sub === 'revoke' && arg) {
            out(args, await c.revokeInvite(arg), `Withdrawn ${arg}.`);
            return 0;
        }
        if (sub === 'accept' && arg) {
            const r = await c.acceptInvite(arg);
            out(args, r, `Joined on the invite. Bonus: ${r.bonus}.`);
            return 0;
        }
        if (sub && sub !== 'list') {
            process.stderr.write(CREDITS_HELP);
            return 1;
        }
        const o = await c.invites();
        const lines = [
            `Invites: ${o.quota.left} of ${o.quota.total} left${o.canInvite ? '' : ` (unlock ${String(o.unlocksAt ?? '').slice(0, 10)})`}`,
            `Bonus:   ${o.bonusCredits} credits each when an invited account confirms`,
            `Link:    ${o.refUrl}`
        ];
        for (const i of o.invites ?? []) lines.push(`  ${i.id}  ${i.status}${i.bonus ? ` (${i.bonus})` : ''}  ${i.note ?? ''}`);
        out(args, o, lines.join('\n'));
        return 0;
    } catch (err) {
        process.stderr.write(`${err.message}\n`);
        return 1;
    }
}

export async function redeem(args) {
    return redeemCode(args, args.positional[0]);
}

export default credits;
