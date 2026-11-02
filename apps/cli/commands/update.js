/**
 * `infernet update` — pull the latest CLI and run autonomous post-upgrade setup.
 *
 * Pulls the latest binary via the official installer, then runs
 * `infernet setup --yes` to regenerate keys, re-register specs, and
 * restart the daemon. No manual steps needed.
 *
 * `infernet upgrade` is an alias for this command.
 */

import { spawn } from 'node:child_process';
import { compareVersions } from '@profullstack/cli';
import setup from './setup.js';
import { CLI_DIR, CURRENT_VERSION, fetchLatestVersion } from '../lib/version.js';
import { pruneCliCopies, wrapperPath, wrapperTarget } from '../lib/cli-copies.js';

const HELP = `infernet update — pull latest CLI + autonomous post-upgrade setup

Usage:
  infernet update [flags]

Flags:
  --check        Check for a newer release without installing it.
  --force        Reinstall when the published version matches (never downgrades).
  --quiet        Suppress routine update progress.
  --skip-setup   Just re-run the installer; don't run setup afterward.
  --keep-copies  Don't remove other npm-global copies of the CLI.
  --help         Show this help.

What it does (fully autonomous, no manual steps):
  1. Re-runs the official installer — pulls the latest source from
     infernetprotocol.com/install.sh, refreshes node_modules, re-writes
     the wrapper. Idempotent.
  2. Runs \`infernet setup --yes\` which:
       - Generates any missing model keypairs (IPIP-0028)
       - Re-registers specs with the control plane
       - Restarts the daemon so the new code is live
       - Verifies the heartbeat reaches the control plane
  3. Keeps one CLI per node: removes npm-global @infernetprotocol/cli
     copies under other Node installs (mise, nvm, system npm) that are
     not the install the wrapper runs, so a stale copy can never shadow
     the current one on PATH. Runs even when nothing new was published.

\`infernet upgrade\` is an alias for this command.
`;

const INSTALLER_URL = "https://infernetprotocol.com/install.sh";

function runShell(cmd) {
    return new Promise((resolve) => {
        const child = spawn("sh", ["-c", cmd], { stdio: "inherit" });
        child.on("exit", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
    });
}

export async function pullLatestBinary({ quiet = false } = {}) {
    if (!quiet) process.stdout.write(`\n→ Pulling latest CLI from ${INSTALLER_URL}\n\n`);
    // INFERNET_AUTOSTART=0: the installer would otherwise run `infernet setup`,
    // which restarts (or, next to infernet.service, duplicates) the daemon from
    // inside its own self-update. Both callers run setup themselves afterwards.
    const code = await runShell(`curl -fsSL ${INSTALLER_URL} | INFERNET_AUTOSTART=0 sh`);
    if (code !== 0) {
        process.stderr.write(`\nerror: installer exited ${code}.\n`);
        return false;
    }
    return true;
}

/**
 * Remove stray npm-global CLI copies (see lib/cli-copies.js). Keeps the copy
 * the installer's wrapper runs; with no wrapper, keeps nothing but the
 * source install, and with neither it removes nothing.
 */
export function cleanCliCopies({ quiet = false, version = null } = {}) {
    try {
        const r = pruneCliCopies({
            keepDirs: [wrapperTarget()],
            version,
            log: (m) => { if (!quiet) process.stdout.write(`  ${m}\n`); }
        });
        for (const d of r.removed) process.stdout.write(`Removed stray infernet CLI copy ${d}\n`);
        for (const d of r.updated) process.stdout.write(`Updated infernet CLI copy ${d} to v${version}\n`);
        for (const f of r.failed) process.stderr.write(`warning: could not clean ${f.dir}: ${f.error}\n`);
        return r;
    } catch (err) {
        process.stderr.write(`warning: CLI copy check failed: ${err?.message ?? err}\n`);
        return null;
    }
}

export default async function update(args, ctx) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }

    const quiet = args.has('quiet');
    const clean = () => { if (!args.has('keep-copies') && !args.has('check')) cleanCliCopies({ quiet, version: CURRENT_VERSION }); };
    const latest = await fetchLatestVersion();
    if (!latest) {
        process.stderr.write('error: could not check the latest Infernet version; installer was not run.\n');
        return 1;
    }
    const comparison = compareVersions(CURRENT_VERSION, latest);
    if (comparison === null) {
        process.stderr.write('error: invalid version from the Infernet update feed; installer was not run.\n');
        return 1;
    }
    if (comparison > 0) {
        if (!quiet) process.stdout.write(`Infernet ${CURRENT_VERSION} is newer than the published ${latest}; refusing to downgrade.\n`);
        clean();
        return 0;
    }
    if (comparison === 0 && !args.has('force')) {
        if (!quiet) process.stdout.write(`Infernet ${CURRENT_VERSION} is already current; skipping reinstall.\n`);
        clean();
        return 0;
    }
    if (args.has('check')) {
        if (!quiet) process.stdout.write(`Infernet update available: ${CURRENT_VERSION} → ${latest}.\n`);
        return 0;
    }

    const ok = await pullLatestBinary({ quiet });
    if (!ok) return 1;

    if (args.has('skip-setup')) {
        if (!args.has('keep-copies')) cleanCliCopies({ quiet, version: latest });
        process.stdout.write("\n✓ Binary updated (skipped setup).\n");
        return 0;
    }

    process.stdout.write("\n→ Running post-upgrade setup (keys + register + daemon restart)\n");

    const passthrough = [];
    for (const k of ['port', 'address', 'no-advertise']) {
        if (!args.has(k)) continue;
        const v = args.get(k);
        passthrough.push(`--${k}`, ...(v === undefined ? [] : [String(v)]));
    }

    // Setup writes the daemon's unit from the CLI that runs it. If this
    // process is not the CLI the installer just installed (a stale npm-global
    // copy, or the npm copy of a node the installer kept on git), running
    // setup here would point infernet.service at this copy, which the cleanup
    // below then deletes: bonita's daemon crash-looped on exactly that during
    // the 0.1.86 rollout. Hand setup to the installed CLI instead, and clean
    // up copies only after it has rewritten the unit.
    const installed = wrapperTarget();
    let code;
    if (setupRunsFrom(installed, CLI_DIR) === 'installed') {
        process.stdout.write(`  (running setup from the installed CLI at ${installed})\n`);
        code = await runInstalledSetup(['setup', '--yes', '--confirm', '--skip-pull', ...passthrough]);
    } else {
        const setupArgs = new Map([['yes', true], ['confirm', true], ['skip-pull', true]]);
        for (const k of ['port', 'address', 'no-advertise']) {
            if (args.has(k)) setupArgs.set(k, args.get(k) ?? true);
        }
        code = await setup(setupArgs, ctx);
    }

    // The installer already pruned other copies (install.sh); this catches an
    // older installer and copies it could not see. After setup, never before.
    if (!args.has('keep-copies')) cleanCliCopies({ quiet, version: latest });
    return code;
}

/** 'installed' when the wrapper runs another CLI than this process. */
export function setupRunsFrom(installedDir, selfDir) {
    return installedDir && installedDir !== selfDir ? 'installed' : 'self';
}

function runInstalledSetup(argv) {
    return new Promise((resolve) => {
        const child = spawn(wrapperPath(), argv, { stdio: 'inherit' });
        child.on('exit', (c) => resolve(c ?? 1));
        child.on('error', (err) => {
            process.stderr.write(`error: could not run the installed CLI: ${err?.message ?? err}\n`);
            resolve(1);
        });
    });
}

export { HELP, INSTALLER_URL };
