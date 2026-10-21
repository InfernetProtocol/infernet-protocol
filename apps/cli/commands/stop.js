/**
 * `infernet stop` — ask the running daemon to shut down.
 *
 * Preferred path: send a `shutdown` message over the IPC socket. The
 * daemon flips its row to `status='offline'`, removes the pid/sock files,
 * and exits cleanly.
 *
 * Fallback: read ~/.config/infernet/daemon.pid and send SIGTERM (or a
 * custom --signal) directly to the process.
 *
 * When `infernet start` left a supervisor running (lib/supervisor.js), it is
 * signalled first: it forwards SIGTERM to the daemon and exits, instead of
 * restarting the daemon we just stopped.
 */

import fs from 'node:fs/promises';

import { getDaemonPidPath } from '../lib/config.js';
import { isDaemonAlive, sendToDaemon } from '../lib/ipc.js';
import { readLiveSupervisorPid } from '../lib/supervisor.js';

const HELP = `infernet stop — signal the running daemon to exit

Usage:
  infernet stop [flags]

Flags:
  --signal <name>   Skip IPC and send this signal directly (default SIGTERM)
  --force           Alias for --signal SIGKILL
  --help            Show this help
`;

export default async function stop(args) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }

    const explicitSignal = args.get('signal') ?? (args.has('force') ? 'SIGKILL' : null);

    const supervisorPid = readLiveSupervisorPid();
    if (supervisorPid) {
        try {
            process.kill(supervisorPid, explicitSignal ?? 'SIGTERM');
            process.stdout.write(`Stopping supervisor (pid ${supervisorPid}) and its daemon.\n`);
        } catch (err) {
            process.stderr.write(`Failed to signal supervisor ${supervisorPid}: ${err.message}\n`);
        }
        // SIGTERM is forwarded to the daemon; any other signal leaves it to us.
        if (!explicitSignal) return 0;
    }

    // Prefer graceful IPC-driven shutdown when available.
    if (!explicitSignal && (await isDaemonAlive())) {
        const res = await sendToDaemon('shutdown', null, { timeoutMs: 5000 });
        if (res.ok) {
            process.stdout.write('Daemon shutting down (IPC).\n');
            return 0;
        }
        process.stderr.write(
            `IPC shutdown failed (${res.error}${res.cause ? `: ${res.cause}` : ''}); falling back to signal.\n`
        );
    }

    // Fallback: read pidfile and signal.
    const signal = explicitSignal ?? 'SIGTERM';
    const pidPath = getDaemonPidPath();
    let raw;
    try { raw = await fs.readFile(pidPath, 'utf8'); }
    catch (err) {
        if (err.code === 'ENOENT') {
            process.stderr.write(`No daemon PID file at ${pidPath}. Is the daemon running?\n`);
            return 1;
        }
        throw err;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
        process.stderr.write(`PID file at ${pidPath} is malformed: "${raw}"\n`);
        return 1;
    }

    try {
        process.kill(pid, signal);
        process.stdout.write(`Sent ${signal} to pid ${pid}\n`);
    } catch (err) {
        if (err.code === 'ESRCH') {
            process.stderr.write(`Process ${pid} is not running; cleaning up stale PID file.\n`);
            try { await fs.unlink(pidPath); } catch { /* ignore */ }
            return 1;
        }
        process.stderr.write(`Failed to signal ${pid}: ${err.message}\n`);
        return 1;
    }
    return 0;
}

export { HELP };
