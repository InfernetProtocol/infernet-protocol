import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const _dir = dirname(fileURLToPath(import.meta.url));

/** The CLI package directory this code is running from. */
export const CLI_DIR = join(_dir, '..');

/**
 * The version of the code that is actually running: the package.json next to
 * this file and nothing else. Before 0.1.84 this was the newest of that and
 * ~/.infernet/source, so a stale npm-global copy shadowing the installer's
 * shim printed the source tree's version while running its own old code.
 */
export const RUNNING_VERSION = readRunningVersion();
/** Kept for existing imports; it is the running version. */
export const CURRENT_VERSION = RUNNING_VERSION;

export function readRunningVersion(dir = CLI_DIR) {
    try {
        const v = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
        return typeof v === 'string' ? v : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/** Version of the installer's git checkout (~/.infernet/source), or null. */
export function readSourceVersion(env = process.env) {
    const sourceHome = env.INFERNET_HOME || join(homedir(), '.infernet');
    try {
        const v = JSON.parse(readFileSync(join(sourceHome, 'source', 'apps', 'cli', 'package.json'), 'utf8')).version;
        return typeof v === 'string' ? v : null;
    } catch {
        return null;
    }
}

/**
 * The newest CLI version installed on this machine right now, read fresh
 * (RUNNING_VERSION is what this process started with). Self-update compares the two after the installer
 * runs: if nothing newer landed, restarting would only repeat the same update
 * every 60 seconds.
 */
export function readInstalledVersion() {
    const versions = [];
    try {
        versions.push(JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8')).version);
    } catch { /* this install may be a source checkout, not an npm package */ }

    // When npm is behind master, install.sh deliberately switches to the git
    // checkout at ~/.infernet/source. The running process still imports this
    // helper from its old npm package, so its adjacent package.json stays at
    // the old version even though the source install and wrapper now point at
    // the newer CLI. Include that source version or the updater will pause for
    // six hours and never restart into the version it just installed.
    const sourceHome = process.env.INFERNET_HOME || join(homedir(), '.infernet');
    try {
        versions.push(JSON.parse(readFileSync(join(sourceHome, 'source', 'apps', 'cli', 'package.json'), 'utf8')).version);
    } catch { /* no source install */ }

    return versions.reduce((latest, version) =>
        typeof version === 'string' && isNewerVersion(latest, version) ? version : latest,
    '0.0.0');
}

export async function fetchLatestVersion() {
    try {
        const res = await fetch(
            'https://infernetprotocol.com/api/cli/latest-version',
            { headers: { accept: 'application/json', 'user-agent': 'infernet-daemon' }, signal: AbortSignal.timeout(10_000) }
        );
        if (!res.ok) return null;
        const data = await res.json();
        return typeof data.version === 'string' ? data.version.replace(/^v/, '') : null;
    } catch {
        return null;
    }
}

export function isNewerVersion(current, candidate) {
    const parse = (v) => String(v).split('.').map(Number);
    const [cMaj, cMin, cPatch] = parse(current);
    const [nMaj, nMin, nPatch] = parse(candidate);
    if (nMaj !== cMaj) return nMaj > cMaj;
    if (nMin !== cMin) return nMin > cMin;
    return nPatch > cPatch;
}
