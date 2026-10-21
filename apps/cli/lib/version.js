import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _dir = dirname(fileURLToPath(import.meta.url));
export const CURRENT_VERSION = readInstalledVersion();

/**
 * The version on disk right now, read fresh (CURRENT_VERSION is what this
 * process started with). Self-update compares the two after the installer
 * runs: if nothing newer landed, restarting would only repeat the same update
 * every 5 minutes.
 */
export function readInstalledVersion() {
    try {
        return JSON.parse(readFileSync(join(_dir, '../package.json'), 'utf8')).version;
    } catch {
        return '0.0.0';
    }
}

export async function fetchLatestVersion() {
    try {
        const res = await fetch(
            'https://api.github.com/repos/infernetprotocol/infernet-protocol/releases/latest',
            { headers: { accept: 'application/vnd.github+json', 'user-agent': 'infernet-daemon' }, signal: AbortSignal.timeout(10_000) }
        );
        if (!res.ok) return null;
        const data = await res.json();
        const tag = typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : null;
        return tag;
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
