/**
 * `infernet house-models` — see and control the house models this node pulls.
 *
 * House models are listed at https://infernetprotocol.com/house-models.json;
 * provider daemons pull the ones that fit, by default. See lib/house-models.js.
 */

import { loadConfig, saveConfig } from '../lib/config.js';
import { isDaemonAlive, sendToDaemon } from '../lib/ipc.js';
import {
    resolveSettings,
    readState,
    formatStatus,
    fetchManifest,
    ollamaTags,
    planSync,
    diskSpace,
    ramGb,
    syncHouseModels
} from '../lib/house-models.js';

const HELP = `infernet house-models — models Infernet publishes for every node to serve

Usage:
  infernet house-models [status]        What is pulled, disk used, last sync
  infernet house-models list            The manifest and whether each model fits here
  infernet house-models sync            Sync now (asks the running daemon)
  infernet house-models off | on        Turn house models off / back on (off removes
                                        the ones the daemon pulled; never yours)
  infernet house-models uncensored off | on
                                        Skip / allow uncensored house models only
  infernet house-models cap <gb>|none   Cap the disk house models may use

Flags:
  --json    Machine-readable output (status, list)
  --help    Show this help

Environment (beats config.json): INFERNET_HOUSE_MODELS=0,
INFERNET_UNCENSORED_MODELS=0, INFERNET_HOUSE_MODELS_MAX_GB=<n>.

House models are ON by default. The daemon checks
https://infernetprotocol.com/house-models.json on start and every 6 hours,
pulls listed models that fit (RAM >= min_ram_gb, and the pull leaves at least
10% of the disk free, 10-50 GB), one at a time (waiting up to 10 min for a running job), verifies
each model's digest, and removes house models that leave the list. A model you
pulled yourself is never removed.
`;

async function setKey(patch) {
    const config = (await loadConfig()) ?? {};
    config.houseModels = { ...(config.houseModels ?? {}), ...patch };
    await saveConfig(config);
    return config;
}

async function nudgeDaemon() {
    if (await isDaemonAlive()) {
        const res = await sendToDaemon('house-models-sync', null, { timeoutMs: 2000 }).catch(() => null);
        if (res?.ok) {
            process.stdout.write('The running daemon is applying it now (see `infernet logs`).\n');
            return;
        }
    }
    process.stdout.write('Takes effect on the daemon\'s next sync (or run `infernet house-models sync`).\n');
}

export default async function houseModels(args) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }
    const [sub = 'status', arg] = args.positional ?? [];
    const config = (await loadConfig().catch(() => null)) ?? {};

    if (sub === 'status') {
        const settings = resolveSettings({ config });
        const state = readState();
        const installed = await ollamaTags().catch(() => null);
        if (args.has('json')) {
            process.stdout.write(JSON.stringify({ settings, state }, null, 2) + '\n');
        } else {
            process.stdout.write(formatStatus({ settings, state, installed }) + '\n');
        }
        return 0;
    }

    if (sub === 'list') {
        const settings = resolveSettings({ config });
        const manifest = await fetchManifest({ url: settings.manifestUrl });
        const installed = await ollamaTags().catch(() => []);
        const disk = await diskSpace();
        const plan = planSync({
            manifest, installed, owned: readState().owned,
            capacity: { ramGb: ramGb(), diskFreeBytes: disk.freeBytes, diskTotalBytes: disk.totalBytes },
            settings
        });
        if (args.has('json')) {
            process.stdout.write(JSON.stringify({ manifest, plan }, null, 2) + '\n');
            return 0;
        }
        const verdict = new Map();
        for (const m of plan.keep) verdict.set(m.ollama_name, 'installed');
        for (const m of plan.pull) verdict.set(m.ollama_name, 'will pull');
        for (const m of plan.update) verdict.set(m.ollama_name, `will update (installed ${String(m.installed_digest ?? '?').replace(/^sha256:/, '').slice(0, 12)}, pinned ${String(m.digest).replace(/^sha256:/, '').slice(0, 12)})`);
        for (const r of plan.remove) verdict.set(r.name, `will remove: ${r.reason}`);
        for (const s of plan.skipped) verdict.set(s.name, `skip: ${s.reason}`);
        process.stdout.write(`manifest: ${settings.manifestUrl}${manifest.updated ? ` (updated ${manifest.updated})` : ''}\n\n`);
        for (const m of manifest.models) {
            process.stdout.write(`${m.ollama_name}${m.uncensored ? '  [uncensored]' : ''}\n`);
            process.stdout.write(`  ${(m.size_bytes / 1024 ** 3).toFixed(1)} GB, needs ${m.min_ram_gb} GB RAM — ${m.description}\n`);
            process.stdout.write(`  here: ${verdict.get(m.ollama_name) ?? '-'}\n`);
        }
        return 0;
    }

    if (sub === 'sync') {
        if (await isDaemonAlive()) {
            const res = await sendToDaemon('house-models-sync', null, { timeoutMs: 2000 }).catch((e) => ({ ok: false, error: e?.message }));
            if (res?.ok) {
                process.stdout.write('Sync started in the daemon; follow it with `infernet logs`, check with `infernet house-models`.\n');
                return 0;
            }
            process.stderr.write(`daemon refused: ${res?.error ?? 'no answer'}\n`);
            return 1;
        }
        process.stdout.write('No daemon running; syncing in this process.\n');
        const summary = await syncHouseModels({
            settings: resolveSettings({ config }),
            log: (m) => process.stdout.write(`${m}\n`)
        });
        process.stdout.write(formatStatus({ settings: resolveSettings({ config }), state: readState() }) + '\n');
        return summary.errors.length > 0 ? 1 : 0;
    }

    if (sub === 'off' || sub === 'on') {
        await setKey({ enabled: sub === 'on' });
        process.stdout.write(`House models turned ${sub} in config.json.\n`);
        await nudgeDaemon();
        return 0;
    }

    if (sub === 'uncensored') {
        if (arg !== 'on' && arg !== 'off') {
            process.stderr.write('Usage: infernet house-models uncensored on|off\n');
            return 1;
        }
        await setKey({ uncensored: arg === 'on' });
        process.stdout.write(`Uncensored house models turned ${arg} in config.json.\n`);
        await nudgeDaemon();
        return 0;
    }

    if (sub === 'cap') {
        if (arg === 'none' || arg === 'off') {
            await setKey({ maxDiskGb: null });
            process.stdout.write('House-models disk cap removed (the 10%-of-disk free reserve, 10-50 GB, still applies).\n');
        } else {
            const gb = Number(arg);
            if (!Number.isFinite(gb) || gb < 0) {
                process.stderr.write('Usage: infernet house-models cap <gb>|none\n');
                return 1;
            }
            await setKey({ maxDiskGb: gb });
            process.stdout.write(`House models may use at most ${gb} GB of disk.\n`);
        }
        await nudgeDaemon();
        return 0;
    }

    process.stderr.write(`unknown subcommand: ${sub}\n\n${HELP}`);
    return 1;
}

export { HELP };
