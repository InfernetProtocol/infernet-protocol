/**
 * `infernet status` — print the current state of this node.
 *
 * Fetches the server-side row via signed POST to /api/v1/node/me and
 * merges it with the live daemon IPC snapshot when the daemon is running.
 */

import { isDaemonAlive, sendToDaemon } from '../lib/ipc.js';
import { formatEndpoint } from '../lib/network.js';
import { formatBalance } from './payout.js';

const HELP = `infernet status — show this node's state

Usage:
  infernet status [flags]

Flags:
  --json    Print JSON combining remote row + live daemon snapshot
  --help    Show this help
`;

function fmtUptime(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '?';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h${m}m${r}s`;
    if (m > 0) return `${m}m${r}s`;
    return `${r}s`;
}

export default async function status(args, ctx) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }

    const { config, client } = ctx;
    const node = config.node ?? {};
    if (!node.role || !node.nodeId) {
        process.stderr.write('Config is missing node.role/node.nodeId. Run `infernet init` first.\n');
        return 1;
    }

    let row = null;
    try {
        const result = await client.me();
        row = result?.row ?? null;
    } catch (err) {
        process.stderr.write(`Remote status lookup failed: ${err?.message ?? err}\n`);
        // Keep going — we can still show the daemon snapshot and local config.
    }

    let daemon = null;
    if (await isDaemonAlive()) {
        const res = await sendToDaemon('status', null, { timeoutMs: 2000 });
        if (res.ok) daemon = res.data;
    }

    if (args.has('json')) {
        process.stdout.write(JSON.stringify({ row, daemon }, null, 2) + '\n');
        return 0;
    }

    process.stdout.write(`Role:       ${node.role}\n`);
    process.stdout.write(`Name:       ${row?.name ?? node.name ?? '(unnamed)'}\n`);
    process.stdout.write(`node_id:    ${row?.node_id ?? node.nodeId}\n`);
    if (row?.id) process.stdout.write(`uuid:       ${row.id}\n`);
    process.stdout.write(
        `Status:     ${row?.status ?? '(unknown)'}${daemon ? ' (daemon running)' : ' (daemon not running)'}\n`
    );
    process.stdout.write(`Last seen:  ${row?.last_seen ?? '(never)'}\n`);
    if (row?.reputation !== undefined) process.stdout.write(`Reputation: ${row.reputation}\n`);
    if (row?.price !== undefined)     process.stdout.write(`Price:      ${row.price}\n`);
    if (row?.address) {
        process.stdout.write(`Endpoint:   ${formatEndpoint(row.address, row.port ?? 0)}\n`);
    }

    if (row?.specs?.gpus && Array.isArray(row.specs.gpus) && row.specs.gpus.length > 0) {
        process.stdout.write(`GPUs:       ${row.specs.gpus.length}\n`);
        for (const g of row.specs.gpus) {
            const tier = g.vram_tier ?? 'unknown';
            const vendor = g.vendor ?? 'unknown';
            const model = g.model ? ` (${g.model})` : '';
            process.stdout.write(`  - ${vendor}:${tier}${model}\n`);
        }
    }

    if (daemon) {
        process.stdout.write(`\nDaemon:     pid=${daemon.pid}, uptime=${fmtUptime(daemon.uptimeMs)}\n`);
        if (daemon.p2p?.enabled) {
            process.stdout.write(`  p2p:      ${daemon.p2p.endpoint} (connections: ${daemon.p2p.connectionsTotal})\n`);
        }
        const s = daemon.stats ?? {};
        process.stdout.write(`  heartbeats: ok=${s.heartbeatsOk} failed=${s.heartbeatsFailed}\n`);
        process.stdout.write(`  jobs:       completed=${s.jobsCompleted} active=${s.activeJobs}\n`);
    }

    if (node.role === 'provider') {
        try {
            const earnings = await client.earnings(1);
            process.stdout.write(formatBalance(earnings?.balance) + '\n');
            if (!earnings?.config?.subsidy_approved && Number(earnings?.balance?.pending_approval_usd) > 0) {
                process.stdout.write('            free-job credits are pending approval of the subsidy rate; see `infernet payout list`\n');
            }
        } catch (err) {
            process.stderr.write(`earnings query failed: ${err?.message ?? err}\n`);
        }
    }
    return 0;
}

export { HELP };
