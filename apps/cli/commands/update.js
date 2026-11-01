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
import { CURRENT_VERSION, fetchLatestVersion } from '../lib/version.js';

const HELP = `infernet update — pull latest CLI + autonomous post-upgrade setup

Usage:
  infernet update [flags]

Flags:
  --check        Check for a newer release without installing it.
  --force        Reinstall when the published version matches (never downgrades).
  --quiet        Suppress routine update progress.
  --skip-setup   Just re-run the installer; don't run setup afterward.
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

export default async function update(args, ctx) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }

    const quiet = args.has('quiet');
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
        return 0;
    }
    if (comparison === 0 && !args.has('force')) {
        if (!quiet) process.stdout.write(`Infernet ${CURRENT_VERSION} is already current; skipping reinstall.\n`);
        return 0;
    }
    if (args.has('check')) {
        if (!quiet) process.stdout.write(`Infernet update available: ${CURRENT_VERSION} → ${latest}.\n`);
        return 0;
    }

    const ok = await pullLatestBinary({ quiet });
    if (!ok) return 1;

    if (args.has('skip-setup')) {
        process.stdout.write("\n✓ Binary updated (skipped setup).\n");
        return 0;
    }

    process.stdout.write("\n→ Running post-upgrade setup (keys + register + daemon restart)\n");

    const setupArgs = new Map([['yes', true], ['confirm', true], ['skip-pull', true]]);
    for (const k of ['port', 'address', 'no-advertise']) {
        if (args.has(k)) setupArgs.set(k, args.get(k) ?? true);
    }

    return setup(setupArgs, ctx);
}

export { HELP, INSTALLER_URL };
