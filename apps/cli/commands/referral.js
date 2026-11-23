/**
 * `infernet referral` — refer nodes and earn a share of the house fee on the
 * paid jobs they serve. The commission comes out of the house fee, never out
 * of the operator's earnings. Terms: infernetprotocol.com/refer#terms
 */
import { resolveReferralOptions, createReferralsClient } from '../lib/referrals-client.js';

export const REFERRAL_HELP = `infernet referral — refer a node, share the house fee

Usage:
  infernet referral [link]                          Your referral link + install commands (creates it once)
  infernet referral stats                           Referred nodes and people, commissions (pending / confirmed / paid)
  infernet referral address <coin> <network> <addr> Where commission payouts go (e.g. USDC polygon 0x...)
  infernet referral payout [usd]                    Withdraw confirmed commissions (default: all available)
  infernet referral admin results                   The commission-term experiment by arm (admin)

Operators being referred:
  infernet register --ref <code>                    or install with INFERNET_REFERRAL=<code>

Options: --json, --url <base>, --token <bearer>
`;

const usd = (n) => `$${(Number(n) || 0).toFixed(Number(n) > 0 && Number(n) < 0.01 ? 6 : 2)}`;

function out(args, data, text) {
    process.stdout.write(args.has('json') ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
}

function linkText(d) {
    return [
        `Referral code: ${d.code}`,
        `Your commission term: ${d.terms?.term?.label ?? '-'}`,
        `Commission: ${d.terms?.commission_pct_of_house_fee}% of the house fee on each paid job a referred node serves`,
        '',
        `  ${d.links?.infernet}`,
        `  ${d.links?.c0mpute}`,
        '',
        'Install commands that carry your code:',
        `  ${d.install?.infernet}`,
        `  ${d.install?.infernet_register}`,
        `  ${d.install?.c0mpute}`,
        `  ${d.install?.c0mpute_register}`
    ].join('\n');
}

function statsText(d) {
    if (!d.has_code) return 'No referral link yet: run `infernet referral link`.';
    const b = d.balance ?? {};
    return [
        `Code ${d.code} · ${d.referred_nodes} referred node(s), ${d.active_nodes_7d} active in 7 days`,
        `${d.referred_people ?? 0} referred people, ${d.spending_people ?? 0} have spent`,
        `Pending ${usd(b.pending_usd)} · confirmed ${usd(b.confirmed_usd)} · available ${usd(b.available_usd)} · requested ${usd(b.requested_usd)} · paid ${usd(b.paid_usd)}`,
        ...(b.by_kind ? [`  from nodes ${usd(b.by_kind.node.confirmed_usd + b.by_kind.node.pending_usd)} · from people's spend ${usd(b.by_kind.spend.confirmed_usd + b.by_kind.spend.pending_usd)}`] : []),
        d.payout_address ? `Payouts to ${d.payout_address.coin}/${d.payout_address.network} ${d.payout_address.address}` : 'No payout address: infernet referral address <coin> <network> <address>',
        ...(d.nodes ?? []).slice(0, 20).map((n) => `  ${n.node}  joined ${String(n.attributed_at).slice(0, 10)}${n.first_paid_job_at ? `  first paid job ${String(n.first_paid_job_at).slice(0, 10)}` : ''}`)
    ].join('\n');
}

export default async function referral(args) {
    const [sub = 'link', ...rest] = args.positional;
    if (args.has('help') || args.has('h') || sub === 'help') {
        process.stdout.write(REFERRAL_HELP);
        return 0;
    }
    const c = createReferralsClient(await resolveReferralOptions({ url: args.get('url'), token: args.get('token') }));
    try {
        if (sub === 'link') {
            const d = await c.link();
            out(args, d, linkText(d));
            return 0;
        }
        if (sub === 'stats' || sub === 'status') {
            const d = await c.stats();
            out(args, d, statsText(d));
            return 0;
        }
        if (sub === 'address') {
            const [coin, network, address] = rest;
            if (!coin || !network || !address) {
                process.stderr.write('Usage: infernet referral address <coin> <network> <address>\n');
                return 1;
            }
            const d = await c.setAddress(coin, network, address);
            out(args, d, `Commission payouts go to ${d.coin}/${d.network} ${d.address}`);
            return 0;
        }
        if (sub === 'payout') {
            const d = await c.payout(rest[0] !== undefined ? Number(rest[0]) : null);
            out(args, d, `Payout ${d.request?.status ?? 'requested'}: ${usd(d.request?.amount_usd)}`);
            return 0;
        }
        if (sub === 'admin' && rest[0] === 'results') {
            const d = await c.results();
            out(args, d, (d.arms ?? []).map((a) => `${a.arm.padEnd(9)} referrers ${a.referrers}  nodes ${a.referred_nodes}  active ${a.active_nodes}  revenue ${usd(a.referred_revenue_usd)}  fee ${usd(a.house_fee_usd)}  accrued ${usd(a.commissions_accrued_usd)}  paid ${usd(a.commissions_paid_usd)}`).join('\n'));
            return 0;
        }
        process.stderr.write(REFERRAL_HELP);
        return 1;
    } catch (err) {
        process.stderr.write(`${err.message}\n`);
        return 1;
    }
}
