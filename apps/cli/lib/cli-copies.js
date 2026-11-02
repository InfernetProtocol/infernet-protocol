/**
 * Find (and prune) every copy of the infernet CLI on this machine.
 *
 * 2026-11-02, node bonita: an npm-global @infernetprotocol/cli@0.1.80 under
 * mise's Node shadowed the installer's shim (~/.local/bin/infernet ->
 * ~/.infernet/source, 0.1.83) because mise's shims dir comes first on PATH.
 * 0.1.80 had no `house-models` command, so `infernet house-models off` (the
 * documented opt-out) became a chat prompt to a model. One CLI version per
 * node is the rule now: the installer and `infernet update` keep the install
 * the wrapper points at and remove every other global copy, and doctor
 * reports what it finds.
 *
 * Also runnable from install.sh (plain node, no workspace deps):
 *   node lib/cli-copies.js --prune --keep <dir|none> [--version X.Y.Z] [--json]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PACKAGE = '@infernetprotocol/cli';

function realpathOr(p) {
    try { return fs.realpathSync(p); } catch { return null; }
}

function readVersion(dir) {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
        return typeof v === 'string' ? v : null;
    } catch {
        return null;
    }
}

function listDirs(parent) {
    try {
        return fs.readdirSync(parent).map((n) => path.join(parent, n));
    } catch {
        return [];
    }
}

/**
 * Every lib/node_modules a global npm install could have used. Version
 * managers each keep one per Node version, which is how a stale copy hides.
 */
export function globalModuleRoots({ env = process.env, home = os.homedir(), npmPrefix = undefined } = {}) {
    const roots = [];
    const add = (prefix) => { if (prefix) roots.push(path.join(prefix, 'lib', 'node_modules')); };

    const miseData = env.MISE_DATA_DIR || path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'mise');
    for (const d of listDirs(path.join(miseData, 'installs', 'node'))) add(d);
    for (const d of listDirs(path.join(env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'))) add(d);
    for (const d of listDirs(path.join(home, '.asdf', 'installs', 'nodejs'))) add(d);
    for (const d of listDirs(path.join(env.FNM_DIR || path.join(home, '.local', 'share', 'fnm'), 'node-versions'))) add(path.join(d, 'installation'));
    add(path.join(home, '.volta', 'tools', 'image', 'packages', PACKAGE));
    add(path.join(home, '.npm-global'));
    add(path.join(home, '.local'));
    if (env.npm_config_prefix) add(env.npm_config_prefix);
    if (env.NPM_CONFIG_PREFIX) add(env.NPM_CONFIG_PREFIX);
    for (const p of ['/usr/local', '/usr', '/opt/homebrew']) add(p);

    let prefix = npmPrefix;
    if (prefix === undefined) {
        const r = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        prefix = r.status === 0 ? r.stdout.trim() : null;
    }
    add(prefix);
    return roots;
}

/**
 * npm-global copies, deduped by real path (mise's 24 / lts / latest are
 * symlinks to one install). Each: { dir, version, prefixes, bins }.
 */
export function findGlobalCopies(opts = {}) {
    const byDir = new Map();
    for (const root of globalModuleRoots(opts)) {
        const pkgDir = path.join(root, PACKAGE);
        const real = realpathOr(pkgDir);
        if (!real || !fs.existsSync(path.join(real, 'package.json'))) continue;
        const prefix = path.dirname(path.dirname(root));
        let copy = byDir.get(real);
        if (!copy) {
            copy = { kind: 'npm-global', dir: real, version: readVersion(real), prefixes: [], bins: [] };
            byDir.set(real, copy);
        }
        if (!copy.prefixes.includes(prefix)) copy.prefixes.push(prefix);
        const bin = path.join(prefix, 'bin', 'infernet');
        const target = realpathOr(bin);
        if (target && target.startsWith(real + path.sep) && !copy.bins.includes(bin)) copy.bins.push(bin);
    }
    return [...byDir.values()];
}

/** The installer's git checkout, if there is one. */
export function findSourceInstall({ env = process.env, home = os.homedir() } = {}) {
    const dir = path.join(env.INFERNET_HOME || path.join(home, '.infernet'), 'source', 'apps', 'cli');
    const real = realpathOr(dir);
    if (!real || !fs.existsSync(path.join(real, 'package.json'))) return null;
    return { kind: 'source', dir: real, version: readVersion(real) };
}

export function wrapperPath({ env = process.env, home = os.homedir() } = {}) {
    return path.join(env.INFERNET_BIN || path.join(home, '.local', 'bin'), 'infernet');
}

/**
 * Which CLI directory the installer's wrapper runs. The git path writes
 * `exec bun "<home>/source/apps/cli/index.js"`, the npm path
 * `exec "<prefix>/bin/infernet"`. Returns a real path or null.
 */
export function wrapperTarget(opts = {}) {
    const w = wrapperPath(opts);
    let text;
    try { text = fs.readFileSync(w, 'utf8'); } catch { return null; }
    if (text.length > 64 * 1024 || !text.startsWith('#!')) {
        // A symlink to index.js, or a binary: resolve it directly.
        const real = realpathOr(w);
        return real ? findPackageDir(real) : null;
    }
    const m = text.match(/^\s*exec\s+(?:[^"\s]\S*\s+)?"([^"]+)"/m);
    if (!m) return null;
    const real = realpathOr(m[1]);
    return real ? findPackageDir(real) : null;
}

function findPackageDir(file) {
    let d = fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() ? file : path.dirname(file);
    for (let i = 0; i < 4; i += 1) {
        try {
            const name = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name;
            if (name === PACKAGE) return d;
        } catch { /* keep walking */ }
        d = path.dirname(d);
    }
    return null;
}

/** Unit / plist files that start a daemon from a CLI path. */
export function serviceFiles({ home = os.homedir() } = {}) {
    const files = [];
    for (const dir of [path.join(home, '.config', 'systemd', 'user'), '/etc/systemd/system', '/lib/systemd/system']) {
        for (const f of listDirs(dir)) if (/\/infernet[^/]*\.service$/.test(f)) files.push(f);
    }
    for (const f of listDirs(path.join(home, 'Library', 'LaunchAgents'))) if (f.includes('infernetprotocol')) files.push(f);
    return files;
}

/** Copies a service starts the daemon from: removing those would break the unit. */
export function copiesUsedByServices(copies, files = serviceFiles()) {
    const used = new Map();
    for (const f of files) {
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        for (const c of copies) {
            const aliases = [c.dir, ...c.prefixes.map((p) => path.join(p, 'lib', 'node_modules', PACKAGE)), ...c.bins];
            if (aliases.some((a) => text.includes(a))) used.set(c.dir, f);
        }
    }
    return used;
}

/**
 * Copies a running process was started from (Linux /proc only). A detached
 * `infernet start` re-execs its own entry on self-update, so deleting its
 * copy under it would leave nothing to restart into.
 */
export function copiesUsedByProcesses(copies, { procDir = '/proc', selfPid = process.pid } = {}) {
    const used = new Map();
    if (copies.length === 0) return used;
    for (const d of listDirs(procDir)) {
        const pid = Number(path.basename(d));
        if (!Number.isInteger(pid) || pid === selfPid) continue;
        let cmd;
        try { cmd = fs.readFileSync(path.join(d, 'cmdline'), 'utf8'); } catch { continue; }
        if (!cmd.includes('infernet')) continue;
        for (const c of copies) {
            const aliases = [c.dir, ...c.prefixes.map((p) => path.join(p, 'lib', 'node_modules', PACKAGE)), ...c.bins];
            if (aliases.some((a) => cmd.includes(a))) used.set(c.dir, `running process ${pid}`);
        }
    }
    return used;
}

/**
 * Pure decision: which copies to keep, update in place, or remove.
 *   copies     findGlobalCopies() output
 *   keepDirs   real paths that ARE the install (the wrapper's target)
 *   usedBy     Map dir -> service file (copiesUsedByServices)
 *   version    the version every kept copy should be on
 */
export function planPrune({ copies, keepDirs = [], usedBy = new Map(), version = null }) {
    const keep = new Set(keepDirs.filter(Boolean));
    const plan = { keep: [], update: [], remove: [] };
    for (const c of copies) {
        if (keep.has(c.dir)) plan.keep.push(c);
        else if (usedBy.has(c.dir)) {
            if (version && c.version !== version) plan.update.push({ ...c, service: usedBy.get(c.dir) });
            else plan.keep.push({ ...c, service: usedBy.get(c.dir) });
        } else plan.remove.push(c);
    }
    return plan;
}

function miseBinary(env = process.env, home = os.homedir()) {
    for (const c of [env.MISE_INSTALL_PATH, path.join(home, '.local', 'bin', 'mise')]) {
        if (c && fs.existsSync(c)) return c;
    }
    const r = spawnSync('sh', ['-c', 'command -v mise'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Remove every global copy that is not the install, update in place the ones
 * a service runs, then `mise reshim` so mise's shim for the removed binary
 * stops shadowing the installer's wrapper. Never uses sudo: a copy we cannot
 * remove is reported, not escalated.
 */
export function pruneCliCopies({
    keepDirs = undefined,
    version = null,
    dryRun = false,
    env = process.env,
    home = os.homedir(),
    log = () => {},
    copies = undefined,
    usedBy = undefined
} = {}) {
    const found = copies ?? findGlobalCopies({ env, home });
    const keep = (keepDirs ?? [wrapperTarget({ env, home })]).filter(Boolean);
    if (keep.length === 0 && !findSourceInstall({ env, home })) {
        // No installer wrapper and no ~/.infernet/source: a global npm copy
        // may be the only CLI here (someone ran `npm i -g` by hand). Never
        // remove it.
        return { kept: found.map((c) => c.dir), updated: [], removed: [], failed: [], skipped: 'no installer wrapper or source install on this machine' };
    }
    const inUse = usedBy ?? new Map([
        ...copiesUsedByProcesses(found),
        ...copiesUsedByServices(found, serviceFiles({ home }))
    ]);
    const plan = planPrune({ copies: found, keepDirs: keep, usedBy: inUse, version });
    const result = { kept: plan.keep.map((c) => c.dir), updated: [], removed: [], failed: [] };

    for (const c of plan.update) {
        const npm = c.prefixes.map((p) => path.join(p, 'bin', 'npm')).find((p) => fs.existsSync(p));
        if (!npm) { result.failed.push({ dir: c.dir, error: `no npm beside it; ${c.service} runs v${c.version}` }); continue; }
        log(`updating ${c.dir} (v${c.version}, used by ${c.service}) to v${version}`);
        if (dryRun) { result.updated.push(c.dir); continue; }
        const r = spawnSync(npm, ['install', '-g', `${PACKAGE}@${version}`], {
            encoding: 'utf8', timeout: 300_000,
            env: { ...env, PATH: `${path.dirname(npm)}:${env.PATH ?? ''}` }
        });
        if (r.status === 0) result.updated.push(c.dir);
        else result.failed.push({ dir: c.dir, error: `npm install exited ${r.status}: ${(r.stderr || '').trim().split('\n').pop()}` });
    }

    for (const c of plan.remove) {
        log(`removing stray ${PACKAGE}@${c.version ?? '?'} at ${c.dir}`);
        if (dryRun) { result.removed.push(c.dir); continue; }
        try {
            for (const b of c.bins) fs.rmSync(b, { force: true });
            fs.rmSync(c.dir, { recursive: true, force: true });
            result.removed.push(c.dir);
        } catch (err) {
            result.failed.push({ dir: c.dir, error: err?.code === 'EACCES' || err?.code === 'EPERM' ? `permission denied (remove it with: sudo npm uninstall -g ${PACKAGE})` : (err?.message ?? String(err)) });
        }
    }

    if (!dryRun && result.removed.length > 0) {
        const mise = miseBinary(env, home);
        if (mise) spawnSync(mise, ['reshim'], { stdio: 'ignore', timeout: 30_000, env });
    }
    return result;
}

/**
 * Every CLI on this machine plus what `infernet` on PATH resolves to.
 * Used by doctor and `infernet --version`.
 */
export function inventory({ env = process.env, home = os.homedir(), runningDir = null } = {}) {
    const copies = findGlobalCopies({ env, home });
    const source = findSourceInstall({ env, home });
    const all = [...(source ? [source] : []), ...copies];
    if (runningDir) {
        const real = realpathOr(runningDir) ?? runningDir;
        if (!all.some((c) => c.dir === real)) all.push({ kind: 'other', dir: real, version: readVersion(real) });
    }
    return { copies: all, wrapper: wrapperTarget({ env, home }), pathFirst: resolvePathInfernet({ env, home, copies }) };
}

/** First `infernet` on PATH and the CLI directory it ends up running. */
export function resolvePathInfernet({ env = process.env, home = os.homedir(), copies = [] } = {}) {
    for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, 'infernet');
        if (!fs.existsSync(p)) continue;
        const real = realpathOr(p);
        // A mise shim is a symlink to mise itself; it runs the active Node's
        // global bin, so name the mise-managed copy.
        if (real && path.basename(real) === 'mise') {
            const miseCopy = copies.find((c) => c.prefixes.some((pre) => pre.includes(`${path.sep}mise${path.sep}installs${path.sep}node${path.sep}`)));
            return { path: p, via: 'mise shim', dir: miseCopy?.dir ?? null };
        }
        if (real && real === realpathOr(wrapperPath({ env, home }))) return { path: p, via: 'installer wrapper', dir: wrapperTarget({ env, home }) };
        return { path: p, via: real && real !== p ? `-> ${real}` : 'file', dir: real ? findPackageDir(real) : null };
    }
    return null;
}

// ---------------------------------------------------------------------------
// CLI entry for install.sh
// ---------------------------------------------------------------------------
const isMain = (() => {
    try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
    const argv = process.argv.slice(2);
    const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
    const keepArg = flag('--keep');
    const keepDirs = keepArg === undefined ? undefined : keepArg === 'none' ? [] : [realpathOr(keepArg) ?? keepArg];
    if (argv.includes('--prune')) {
        const r = pruneCliCopies({
            keepDirs,
            version: flag('--version') ?? null,
            dryRun: argv.includes('--dry-run'),
            log: (m) => process.stdout.write(`  ${m}\n`)
        });
        if (argv.includes('--json')) process.stdout.write(JSON.stringify(r) + '\n');
        for (const f of r.failed) process.stderr.write(`  could not clean ${f.dir}: ${f.error}\n`);
        process.exitCode = r.failed.length ? 1 : 0;
    } else {
        process.stdout.write(JSON.stringify(inventory(), null, 2) + '\n');
    }
}
