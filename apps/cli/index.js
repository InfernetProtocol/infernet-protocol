#!/usr/bin/env node
/**
 * `infernet` — GPU-node CLI / daemon for the Infernet Protocol.
 *
 * This is NOT Next.js code. It is a standalone Node.js ESM binary intended
 * to ship with (or alongside) the control-plane app; GPU operators install
 * it on each rented/owned server to register the node, heartbeat, accept
 * jobs, and report earnings.
 *
 * Nodes authenticate to the control plane using Nostr-signed HTTP requests.
 * No database credentials are stored on the node — the signing keypair IS
 * the credential.
 */

import { loadConfig, getConfigPath } from './lib/config.js';
import { createNodeClientFromConfig } from './lib/node-client.js';
import { decideRoute, unknownCommandMessage } from './lib/route.js';
import { CLI_DIR, RUNNING_VERSION, fetchLatestVersion, isNewerVersion } from './lib/version.js';
import { inventory } from './lib/cli-copies.js';

import help, { USAGE } from './commands/help.js';
import init from './commands/init.js';
import login from './commands/login.js';
import register from './commands/register.js';
import update from './commands/update.js';
import upgrade from './commands/upgrade.js';
import remove from './commands/remove.js';
import start from './commands/start.js';
import status from './commands/status.js';
import stop from './commands/stop.js';
import stats from './commands/stats.js';
import logs from './commands/logs.js';
import payout from './commands/payout.js';
import payments from './commands/payments.js';
import gpu from './commands/gpu.js';
import firewall from './commands/firewall.js';
import chat from './commands/chat.js';
import setup from './commands/setup.js';
import houseModels from './commands/house-models.js';
import model from './commands/model.js';
import tui from './commands/tui.js';
import doctor from './commands/doctor.js';
import service from './commands/service.js';
import pubkey from './commands/pubkey.js';
import debug from './commands/debug.js';
import deploy from './commands/deploy.js';
import consoleCmd from './commands/console.js';
import train from './commands/train.js';
import publish from './commands/publish.js';
import inference from './commands/inference.js';
import rpc from './commands/rpc.js';
import uncensored from './commands/uncensored.js';
import reservation from './commands/reservation.js';
import order from './commands/order.js';
import mcp from './commands/mcp.js';
import credits, { invites, redeem } from './commands/credits.js';
import batch, { billing, keys } from './commands/batch.js';
import price from './commands/price.js';

function parseArgs(argv) {
    const positional = [];
    const flags = new Map();

    for (let i = 0; i < argv.length; i += 1) {
        const tok = argv[i];
        if (tok === '--') {
            positional.push(...argv.slice(i + 1));
            break;
        }
        if (tok.startsWith('--')) {
            const body = tok.slice(2);
            const eq = body.indexOf('=');
            if (eq >= 0) {
                flags.set(body.slice(0, eq), body.slice(eq + 1));
            } else {
                const next = argv[i + 1];
                if (next !== undefined && !next.startsWith('-')) {
                    flags.set(body, next);
                    i += 1;
                } else {
                    flags.set(body, true);
                }
            }
        } else if (tok.startsWith('-') && tok.length > 1) {
            const body = tok.slice(1);
            if (body === 'h') {
                flags.set('help', true);
                flags.set('h', true);
            } else {
                flags.set(body, true);
            }
        } else {
            positional.push(tok);
        }
    }

    return {
        positional,
        flags,
        has(name) { return flags.has(name); },
        get(name) {
            const v = flags.get(name);
            if (v === undefined) return undefined;
            return v === true ? undefined : v;
        }
    };
}

async function restart(args, ctx) {
    const stopCode = await stop(args, ctx);
    if (stopCode !== 0) return stopCode;
    return start(args, ctx);
}

const COMMANDS = {
    init, login, register, update, upgrade, remove,
    // aliases
    uninstall: remove,
    start, status, stop, restart, stats, logs,
    payout, payments, gpu, firewall, chat, setup, model, train, publish, inference, rpc, uncensored, reservation, reservations: reservation, order, orders: order, mcp, credits, invites, redeem, batch, batches: batch, billing, keys, tui, doctor, service, pubkey, debug, deploy, console: consoleCmd, help,
    price, prices: price,
    'house-models': houseModels, house: houseModels
};

// Commands that can run without a loaded config.
const NO_CONFIG = new Set(['init', 'login', 'help', 'stats', 'logs', 'stop', 'restart', 'gpu', 'firewall', 'chat', 'setup', 'model', 'train', 'publish', 'inference', 'rpc', 'uncensored', 'reservation', 'reservations', 'order', 'orders', 'mcp', 'credits', 'invites', 'redeem', 'batch', 'batches', 'billing', 'keys', 'tui', 'doctor', 'service', 'pubkey', 'debug', 'deploy', 'console', 'upgrade', 'update', 'remove', 'uninstall', 'house-models', 'house', 'price', 'prices']);
// Commands that need a config but not a control-plane client (none today
// — kept as a future escape hatch).
const NO_CLIENT = new Set();

const KNOWN_COMMAND_NAMES = new Set(Object.keys(COMMANDS));

async function printVersion({ verbose = false } = {}) {
    // The version of THIS code, read from the package.json beside it. Not the
    // newest version on disk: a stale copy that says it is current is how a
    // node ran 0.1.80 code under a "v0.1.83" banner.
    process.stdout.write(`infernet v${RUNNING_VERSION}${verbose ? `  (${CLI_DIR})` : ''}\n`);
    try {
        const inv = inventory({ runningDir: CLI_DIR });
        const others = inv.copies.filter((c) => c.dir !== CLI_DIR && c.version && c.version !== RUNNING_VERSION);
        for (const c of others) {
            process.stdout.write(`  other copy: v${c.version} at ${c.dir}\n`);
        }
        if (inv.pathFirst?.dir && inv.pathFirst.dir !== CLI_DIR) {
            process.stdout.write(`  note: \`infernet\` on PATH (${inv.pathFirst.path}, ${inv.pathFirst.via}) runs ${inv.pathFirst.dir}\n`);
        }
        if (others.length) process.stdout.write('  more than one CLI version on this machine: run `infernet upgrade` (keeps one) and `infernet doctor`\n');
    } catch { /* inventory is advisory */ }
    const latest = await fetchLatestVersion();
    if (!latest) {
        process.stdout.write(`  update check failed (offline?)\n`);
    } else if (isNewerVersion(RUNNING_VERSION, latest)) {
        process.stdout.write(`  update available: v${latest}  →  run \`infernet upgrade\`\n`);
    } else {
        process.stdout.write(`  up to date\n`);
    }
}

async function main() {
    const argv = process.argv.slice(2);

    // --version / -v / -V  (checked before full routing)
    if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === '-V') {
        await printVersion({ verbose: true });
        process.exit(0);
    }

    const route = decideRoute(argv, KNOWN_COMMAND_NAMES, { isTTY: !!process.stdin.isTTY });
    const sub = route.command;
    const rest = route.rest;

    if (sub === 'unknown') {
        process.stderr.write(unknownCommandMessage(route.name, { version: RUNNING_VERSION, entry: CLI_DIR }));
        process.exit(2);
    }

    if (sub === 'help') {
        // Bare `infernet` → show version + up-to-date status, then help.
        if (argv.length === 0) {
            await printVersion();
            process.stdout.write('\n');
        }
        await help();
        process.exit(argv.length === 0 ? 0 : 0);
    }

    const handler = COMMANDS[sub];
    if (!handler) {
        // Defensive — decideRoute should never return a name we don't have.
        process.stderr.write(`Internal error: no handler for '${sub}'\n\n`);
        process.stderr.write(USAGE);
        process.exit(1);
    }

    const args = parseArgs(rest);

    let ctx = { config: null, client: null, configPath: getConfigPath() };

    const helpRequested = args.has('help') || args.has('h');

    // `infernet payout admin ...` runs on an admin's machine with only the
    // admin token, not a node config.
    const adminOnly = sub === 'payout' && rest[0] === 'admin';

    if (!NO_CONFIG.has(sub) && !helpRequested && !adminOnly) {
        const config = await loadConfig();
        if (!config) {
            process.stderr.write(
                `No infernet config found at ${getConfigPath()}. Run \`infernet init\` first.\n`
            );
            process.exit(1);
        }
        let client = null;
        if (!NO_CLIENT.has(sub)) {
            try {
                client = createNodeClientFromConfig(config);
            } catch (err) {
                process.stderr.write(`${err.message}\n`);
                process.exit(1);
            }
        }
        ctx = { config, client, configPath: getConfigPath() };
    }

    try {
        const code = await handler(args, ctx);
        process.exit(typeof code === 'number' ? code : 0);
    } catch (err) {
        process.stderr.write(`Error: ${err?.message ?? err}\n`);
        if (process.env.INFERNET_DEBUG) {
            process.stderr.write(String(err?.stack ?? '') + '\n');
        }
        process.exit(1);
    }
}

main().catch((err) => {
    process.stderr.write(`Fatal: ${err?.message ?? err}\n`);
    if (process.env.INFERNET_DEBUG) {
        process.stderr.write(String(err?.stack ?? '') + '\n');
    }
    process.exit(1);
});
