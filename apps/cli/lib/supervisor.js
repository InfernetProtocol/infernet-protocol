/**
 * Built-in supervisor for the node daemon.
 *
 * `infernet start` used to detach ONE `start --foreground` process with nothing
 * watching it: a crash, an OOM kill or a failed self-update re-exec left the node
 * dead until the operator noticed (most outside nodes, 2026-05..10). Now the
 * detached process is this supervisor, which runs the daemon as a child and
 * restarts it.
 *
 * Exit-code contract (shared with systemd `Restart=on-failure` and launchd
 * `KeepAlive.SuccessfulExit=false`):
 *   0                 deliberate stop (`infernet stop`, SIGTERM): stay down
 *   EXIT_RESTART (75) restart now (self-update installed a new version)
 *   anything else     crash: restart with backoff
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getConfigDir, getDaemonLogPath } from './config.js';

export const EXIT_RESTART = 75;

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** A child that stayed up this long resets the backoff. */
const HEALTHY_AFTER_MS = 10 * 60_000;

export function getSupervisorPidPath() {
    return path.join(getConfigDir(), 'supervisor.pid');
}

/**
 * True when something will restart this daemon after it exits non-zero: our
 * supervisor, our systemd/launchd units, or any systemd unit (INVOCATION_ID).
 */
export function isSupervised(env = process.env) {
    return env.INFERNET_SUPERVISED === '1'
        || Boolean(env.INVOCATION_ID)
        || (env.XPC_SERVICE_NAME ?? '').startsWith('com.infernetprotocol.');
}

/** Next backoff delay: doubles from 1 s, capped at 60 s; reset after a healthy run. */
export function nextBackoff(prevMs, ranForMs) {
    if (ranForMs >= HEALTHY_AFTER_MS || !prevMs) return BACKOFF_START_MS;
    return Math.min(prevMs * 2, BACKOFF_MAX_MS);
}

/**
 * Whether the supervisor should start the daemon again after it exited.
 * `signal` is set when the child was killed (OOM killer, kill -9): restart.
 */
export function shouldRestart(code, signal) {
    if (signal) return true;
    return code !== 0;
}

/** Pid of a live supervisor from supervisor.pid, or null. */
export function readLiveSupervisorPid() {
    let raw;
    try { raw = fs.readFileSync(getSupervisorPidPath(), 'utf8'); } catch { return null; }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return pid; } catch { return null; }
}

/** The user-level systemd unit (`infernet service install`) is installed and enabled. */
export function userServiceEnabled() {
    if (process.platform !== 'linux') return false;
    const r = spawnSync('systemctl', ['--user', 'is-enabled', '--quiet', 'infernet.service'], { stdio: 'ignore' });
    return r.status === 0;
}

/**
 * Detach a supervisor (`start --supervise`) that runs `start --foreground`.
 * @param {string[]} passthroughArgs
 * @returns {{ pid: number, logPath: string }}
 */
export function spawnDetachedSupervisor(passthroughArgs = []) {
    fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    const logPath = getDaemonLogPath();
    const out = fs.openSync(logPath, 'a');
    const scriptPath = process.argv[1];
    if (!scriptPath || !path.isAbsolute(scriptPath)) {
        throw new Error('Unable to determine absolute path to the CLI script for daemonization.');
    }
    const child = spawn(
        process.execPath,
        [scriptPath, 'start', '--supervise', ...passthroughArgs],
        { detached: true, stdio: ['ignore', out, out], env: process.env }
    );
    child.unref();
    return { pid: child.pid, logPath };
}

/**
 * Supervisor loop. Runs until the daemon exits 0 or the supervisor is signalled.
 * @param {string[]} passthroughArgs
 * @returns {Promise<number>}
 */
export async function runSupervisor(passthroughArgs = []) {
    const pidPath = getSupervisorPidPath();
    fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
    const log = (msg) => process.stdout.write(`[supervisor ${new Date().toISOString()}] ${msg}\n`);

    let child = null;
    let stopping = false;
    let wake = null;
    const stop = (signal) => {
        if (stopping) return;
        stopping = true;
        log(`${signal}: stopping daemon`);
        if (child) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
        if (wake) wake();
    };
    const onTerm = () => stop('SIGTERM');
    const onInt = () => stop('SIGINT');
    const onHup = () => { /* survive the terminal closing */ };
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    process.on('SIGHUP', onHup);

    let backoff = 0;
    try {
        while (!stopping) {
            const startedAt = Date.now();
            // Re-read argv[1] each time: an upgrade replaces the files at the same path.
            child = spawn(process.execPath, [process.argv[1], 'start', '--foreground', ...passthroughArgs], {
                stdio: ['ignore', 'inherit', 'inherit'],
                env: { ...process.env, INFERNET_DAEMON_FOREGROUND: '1', INFERNET_SUPERVISED: '1' }
            });
            log(`daemon started (pid ${child.pid})`);
            const { code, signal } = await new Promise((resolve) => {
                child.once('exit', (c, s) => resolve({ code: c, signal: s }));
                child.once('error', (err) => {
                    log(`spawn failed: ${err?.message ?? err}`);
                    resolve({ code: 1, signal: null });
                });
            });
            child = null;
            if (stopping) break;
            if (!shouldRestart(code, signal)) {
                log('daemon exited 0 (stopped on purpose); supervisor exiting');
                break;
            }
            if (code === EXIT_RESTART) {
                backoff = 0;
                log('daemon asked for a restart (update installed)');
                continue;
            }
            backoff = nextBackoff(backoff, Date.now() - startedAt);
            log(`daemon died (${signal ?? `exit ${code}`}); restarting in ${backoff / 1000}s`);
            await new Promise((resolve) => {
                wake = resolve;
                setTimeout(resolve, backoff);
            });
            wake = null;
        }
    } finally {
        process.off('SIGTERM', onTerm);
        process.off('SIGINT', onInt);
        process.off('SIGHUP', onHup);
        try {
            if (fs.readFileSync(pidPath, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidPath);
        } catch { /* already gone */ }
    }
    return 0;
}
