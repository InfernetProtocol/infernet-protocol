/**
 * `infernet remove` — deregister this node, wipe local config, and
 * uninstall the CLI binary.
 *
 * This is the inverse of the curl installer:
 *
 *   curl -fsSL https://infernetprotocol.com/install.sh | sh
 *
 * The installer drops files in three layers:
 *   1. ~/.config/infernet/             — node identity + daemon state
 *   2. ~/.infernet/source              — git clone + node_modules
 *   3. ~/.local/bin/infernet           — wrapper shim
 *      /usr/local/bin/infernet         — system symlink (any of these)
 *      /usr/bin/infernet               — system symlink
 *      /opt/bin/infernet               — system symlink
 *      /etc/profile.d/infernet.sh      — login-shell PATH hook
 *
 * `remove` peels all three back. Flags let operators keep any layer:
 *
 *   --keep-config      Skip wiping ~/.config/infernet
 *   --keep-binary      Skip wiping the install dir + wrapper
 *   --keep-remote      Skip the deregister-from-control-plane step
 *   --yes              Don't prompt for confirmation
 *
 * For backwards compat, `--purge` is accepted but is the default
 * (full uninstall). To do a partial cleanup, pass --keep-* flags.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getConfigDir, getConfigPath, getDaemonPidPath, loadConfig } from '../lib/config.js';
import { createNodeClientFromConfig } from '../lib/node-client.js';
import { question } from '../lib/prompt.js';

const HELP = `infernet remove — deregister this node and uninstall the CLI

Usage:
  infernet remove [flags]

Flags:
  --yes            Skip confirmation prompt
  --keep-config    Leave ~/.config/infernet/config.json in place
  --keep-binary    Leave ~/.infernet and ~/.local/bin/infernet in place
  --keep-remote    Leave the remote row intact (don't deregister)
  --help           Show this help

By default this:
  1. Deregisters this node from the control plane (signed POST).
  2. Deletes ~/.config/infernet/ (node identity + daemon state).
  3. Removes the install dir (~/.infernet) and the wrapper at
     ~/.local/bin/infernet, plus any system symlinks (/usr/local/bin,
     /usr/bin, /opt/bin) and /etc/profile.d/infernet.sh.

  Step 3 is the inverse of the curl one-line installer.
`;

const SYSTEM_BIN_DIRS = ['/usr/local/bin', '/usr/bin', '/opt/bin'];
const PROFILE_D_HOOK = '/etc/profile.d/infernet.sh';

async function unlinkIfExists(p) {
    try { await fs.unlink(p); return true; }
    catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}

async function rmdirIfExists(p) {
    try { await fs.rm(p, { recursive: true, force: true }); return true; }
    catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}

function home() {
    return process.env.HOME || os.homedir();
}

function resolveInstallDir() {
    return process.env.INFERNET_HOME || path.join(home(), '.infernet');
}

function resolveBinDir() {
    return process.env.INFERNET_BIN || path.join(home(), '.local', 'bin');
}

async function tryUnlink(p, removed) {
    try {
        await fs.unlink(p);
        removed.push(p);
        return true;
    } catch (err) {
        if (err.code === 'ENOENT') return false;
        // EACCES/EPERM on /usr/local/bin etc. is normal for non-root.
        return false;
    }
}

async function uninstallBinary() {
    const removed = [];
    const skipped = [];

    // 1. The install dir (clone + node_modules + vllm venv).
    const installDir = resolveInstallDir();
    if (await rmdirIfExists(installDir)) {
        removed.push(installDir);
    }

    // 2. The user-space wrapper.
    const wrapper = path.join(resolveBinDir(), 'infernet');
    if (await unlinkIfExists(wrapper)) {
        removed.push(wrapper);
    }

    // 3. System-bin symlinks. These usually need root, so collect what
    //    we can't unlink for the operator to clean up by hand.
    for (const dir of SYSTEM_BIN_DIRS) {
        const link = path.join(dir, 'infernet');
        try {
            await fs.lstat(link);
        } catch (err) {
            if (err.code === 'ENOENT') continue;
        }
        const ok = await tryUnlink(link, removed);
        if (!ok) skipped.push(link);
    }

    // 4. /etc/profile.d hook.
    try {
        await fs.access(PROFILE_D_HOOK);
        const ok = await tryUnlink(PROFILE_D_HOOK, removed);
        if (!ok) skipped.push(PROFILE_D_HOOK);
    } catch { /* not present */ }

    return { removed, skipped };
}

export default async function remove(args, ctx) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }

    let config = ctx?.config ?? null;
    let client = ctx?.client ?? null;
    // The router puts `remove` in NO_CONFIG so it can still wipe a
    // half-broken box; load config opportunistically so we can also
    // deregister when there IS one.
    if (!config) config = await loadConfig().catch(() => null);
    if (config && !client) {
        try { client = createNodeClientFromConfig(config); }
        catch { client = null; }
    }
    const node = config?.node ?? {};
    const keepConfig = args.has('keep-config');
    const keepBinary = args.has('keep-binary');
    const keepRemote = args.has('keep-remote');
    const assumeYes = args.has('yes') || args.has('y');

    const haveConfig = !!config;
    const haveClient = !!client;
    const canDeregister = !keepRemote && haveConfig && haveClient && node.nodeId;

    const summary = [];
    if (canDeregister) {
        summary.push(`  - deregister ${node.role} "${node.nodeId}" from ${config.controlPlane?.url}`);
    } else if (!keepRemote && haveConfig && !node.nodeId) {
        summary.push('  - (skip remote deregister — config has no node.nodeId)');
    } else if (!keepRemote && !haveConfig) {
        summary.push('  - (skip remote deregister — no local config to identify this node)');
    }
    if (!keepConfig) {
        summary.push(`  - delete local config at ${getConfigPath()}`);
    }
    if (!keepBinary) {
        summary.push(`  - remove install dir ${resolveInstallDir()}`);
        summary.push(`  - remove wrapper at ${path.join(resolveBinDir(), 'infernet')}`);
        summary.push(`  - remove system symlinks (${SYSTEM_BIN_DIRS.join(', ')}) and ${PROFILE_D_HOOK}`);
    }

    if (summary.length === 0) {
        process.stdout.write('Nothing to do (everything kept via flags).\n');
        return 0;
    }

    process.stdout.write('This will:\n');
    for (const line of summary) process.stdout.write(`${line}\n`);

    if (!assumeYes) {
        if (!process.stdin.isTTY) {
            process.stderr.write('\nRefusing to proceed without --yes in non-interactive mode.\n');
            return 1;
        }
        const answer = (await question('\nContinue? [y/N] ', { default: 'n' })) ?? 'n';
        if (!/^y(es)?$/i.test(answer.trim())) {
            process.stdout.write('Aborted.\n');
            return 0;
        }
    }

    if (canDeregister) {
        try {
            await client.remove();
            process.stdout.write(`Deregistered ${node.role} "${node.nodeId}"\n`);
        } catch (err) {
            process.stderr.write(`Remote deregister failed: ${err?.message ?? err}\n`);
            // Don't bail — operator wants this gone locally either way.
        }
    }

    if (!keepConfig) {
        await unlinkIfExists(getDaemonPidPath());
        await rmdirIfExists(getConfigDir());
        process.stdout.write('Local config removed.\n');
    }

    if (!keepBinary) {
        try {
            const { removeAutoUpdate } = await import('@profullstack/cli/auto-update');
            await removeAutoUpdate('infernet');
        } catch { /* older installs may not have the shared updater dependency */ }
        const { removed, skipped } = await uninstallBinary();
        for (const p of removed) process.stdout.write(`Removed ${p}\n`);
        if (skipped.length > 0) {
            process.stdout.write('\nThese paths still exist (need root to unlink):\n');
            for (const p of skipped) process.stdout.write(`  ${p}\n`);
            process.stdout.write('\nClean up with:\n');
            process.stdout.write(`  sudo rm -f ${skipped.join(' ')}\n`);
        }
        process.stdout.write('\nIf you installed via npm, also run:\n');
        process.stdout.write('  npm uninstall -g @infernetprotocol/cli\n');
    }

    return 0;
}

export { HELP };
