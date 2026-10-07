/**
 * `infernet start` — run the node daemon loop.
 *
 * By default, `infernet start` spawns a **detached** background process and
 * returns immediately; logs go to `~/.config/infernet/daemon.log`. Use
 * `--foreground` to run the loop in the current terminal (useful under
 * systemd / Docker / Kubernetes where the supervisor wants the process in
 * the foreground).
 *
 * The running daemon:
 *   - Heartbeats every 30s via signed POST /api/v1/node/heartbeat
 *   - Polls /api/v1/node/jobs/poll every 15s (providers only), processes
 *     any returned jobs, emits streaming events via signed
 *     POST /api/v1/node/jobs/:id/events, and closes the loop with
 *     POST /api/v1/node/jobs/:id/complete.
 *   - Exposes a Unix-domain IPC socket at `~/.config/infernet/daemon.sock`
 *     so `infernet status`, `infernet stats`, `infernet stop`, etc. can ask
 *     the live process what it's doing.
 *   - Handles SIGINT / SIGTERM: sends a final heartbeat with status=offline,
 *     removes pid/sock files, exits 0.
 *
 * The daemon never holds a database credential. Every request to the
 * control plane is signed with the node's Nostr privkey.
 */

import fs from 'node:fs/promises';
import { openSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, unlinkSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    getDaemonPidPath,
    getDaemonSocketPath,
    getDaemonLogPath,
    loadConfig,
    saveConfig,
    fixConfigPermissions
} from '../lib/config.js';
import { spawnDetachedDaemon } from '../lib/daemonize.js';
import { isDaemonAlive } from '../lib/ipc.js';
import { resolveP2pPort, detectLocalAddress, formatEndpoint } from '../lib/network.js';
import { executeChatJob, failChatJob, shutdownEngine } from '../lib/chat-executor.js';
import { gatherCoarseSpecs } from './register.js';
import { checkModelFits, formatFitFailure } from '../lib/model-fit.js';
import { downloadHfModel, resolveHfToken } from '../lib/hf-model.js';
import { startVllmServe, stopVllmServe, vllmInstalled, waitForVllmModel, extractVllmError } from '../lib/vllm.js';
import { detectGpus, detectHost } from '@infernetprotocol/gpu';
import { getOrCreateModelKey, getModelPublicKeys } from '../lib/model-key.js';
import { pullLatestBinary } from './upgrade.js';
import { nodeTokenLogin } from './login.js';
import { CURRENT_VERSION, fetchLatestVersion, isNewerVersion } from '../lib/version.js';
import { readInferenceState, readInferenceStateSync, isPidAlive } from '../lib/inference/state.js';

function readInferenceStateSyncSafe() {
    try { return readInferenceStateSync(); } catch { return {}; }
}

const HELP = `infernet start — run the node daemon

Usage:
  infernet start [flags]

Flags:
  --foreground               Run in the current terminal (don't detach)
  --heartbeat-interval <ms>  Override heartbeat cadence (default 30000)
  --poll-interval <ms>       Override job poll cadence (default 15000)
  --p2p-port <n>             TCP port for peer connections (default 46337)
  --no-p2p                   Don't bind the P2P TCP listener
  --no-advertise             Don't send address/port in heartbeats
  --once                     Run one heartbeat + one poll and exit (debug)
  --help                     Show this help

Daemon logs to \`~/.config/infernet/daemon.log\`, exposes an IPC socket for
live queries (see \`infernet status\`, \`infernet stats\`, \`infernet logs\`).
`;

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_POLL_MS = 15_000;
const UPDATE_CHECK_MS = 5 * 60 * 1000; // 5 minutes
const UPDATE_DRAIN_MS = 10 * 60 * 1000; // wait for in-flight jobs before restarting

async function writePidFile(pid) {
    const p = getDaemonPidPath();
    await fs.writeFile(p, String(pid), { mode: 0o600 });
    return p;
}

async function removePidFile() {
    try { await fs.unlink(getDaemonPidPath()); } catch { /* ignore */ }
}

function removeSocketFile() {
    try { unlinkSync(getDaemonSocketPath()); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Entry point — branch between "spawn detached" and "run foreground loop".
// ---------------------------------------------------------------------------
export default async function start(args, ctx) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }

    const foreground = args.has('foreground') || process.env.INFERNET_DAEMON_FOREGROUND === '1';
    if (!foreground) {
        return spawnAndReturn(args);
    }
    return runDaemon(args, ctx);
}

async function spawnAndReturn(args) {
    const alreadyAlive = await isDaemonAlive();
    if (alreadyAlive) {
        process.stderr.write('A daemon is already running (socket responsive). Run `infernet stop` first.\n');
        return 1;
    }
    removeSocketFile();

    const passthrough = [];
    const hb = args.get('heartbeat-interval');
    if (hb) passthrough.push('--heartbeat-interval', hb);
    const poll = args.get('poll-interval');
    if (poll) passthrough.push('--poll-interval', poll);
    const p2pPort = args.get('p2p-port');
    if (p2pPort) passthrough.push('--p2p-port', p2pPort);
    if (args.has('no-p2p')) passthrough.push('--no-p2p');
    if (args.has('no-advertise')) passthrough.push('--no-advertise');
    if (args.has('once')) passthrough.push('--once');

    const { pid, logPath } = spawnDetachedDaemon(passthrough);
    process.stdout.write(`infernet daemon started (pid ${pid})\n`);
    process.stdout.write(`  logs:   ${logPath}\n`);
    process.stdout.write(`  socket: ${getDaemonSocketPath()}\n`);
    process.stdout.write('Tail logs with `infernet logs -f`, query live state with `infernet status`.\n');
    return 0;
}

async function runDaemon(args, ctx) {
    const { config, client, configPath } = ctx;
    const node = config.node ?? {};
    if (!node.role || !node.nodeId) {
        process.stderr.write('Config is missing node.role/node.nodeId. Run `infernet init` first.\n');
        return 1;
    }

    const heartbeatMs = Number.parseInt(args.get('heartbeat-interval') ?? '', 10) || DEFAULT_HEARTBEAT_MS;
    const pollMs     = Number.parseInt(args.get('poll-interval') ?? '', 10)      || DEFAULT_POLL_MS;
    const once       = args.has('once');

    const p2pDisabled = args.has('no-p2p');
    const noAdvertise = args.has('no-advertise') || node.address === null;
    // Bind port (what we listen on, locally) and advertised port (what we
    // tell the control plane to dial). Same value 99% of the time, but
    // hosting platforms that NAT the container (RunPod, anything with
    // dynamic port mapping) need them split — daemon binds to e.g. 46337
    // inside the container, but the public address:port is something like
    // 213.173.107.42:21517. The cloud-init detects RunPod env vars and
    // exports INFERNET_BIND_PORT (internal) + INFERNET_PUBLIC_PORT
    // (external) separately.
    const bindPort = Number.parseInt(
        args.get('bind-port') ?? process.env.INFERNET_BIND_PORT ?? '',
        10
    ) || Number.parseInt(args.get('p2p-port') ?? '', 10) || resolveP2pPort(config);
    const advertisedPort = Number.parseInt(
        args.get('p2p-port') ?? process.env.INFERNET_PUBLIC_PORT ?? '',
        10
    ) || resolveP2pPort(config) || bindPort;
    // Back-compat: keep the existing variable name pointing at bindPort,
    // since the rest of the file (P2P listener, formatEndpoint, etc.)
    // wants the bind value.
    const p2pPort = bindPort;
    const advertisedAddress = noAdvertise ? null : (node.address ?? await detectLocalAddress());

    const startedAt = new Date();
    const stats = {
        heartbeatsOk: 0,
        heartbeatsFailed: 0,
        lastHeartbeatAt: null,
        lastHeartbeatError: null,
        jobsPicked: 0,
        jobsCompleted: 0,
        jobsFailed: 0,
        lastJobAt: null,
        lastPollAt: null,
        pollsOk: 0,
        pollsFailed: 0,
        activeJobIds: new Set(),
        // Set while a self-update waits for in-flight jobs to finish: the
        // poll loop takes no new jobs, so the restart can happen.
        draining: false
    };

    const pidPath = await writePidFile(process.pid);
    const socketPath = getDaemonSocketPath();
    removeSocketFile();

    // Self-heal: fix config permissions on every daemon start so nodes
    // upgraded before the 0600 enforcement still get corrected.
    fixConfigPermissions().catch(() => {});

    process.stdout.write('infernet daemon starting\n');
    process.stdout.write(`  node_id:   ${node.nodeId}\n`);
    process.stdout.write(`  role:      ${node.role}\n`);
    process.stdout.write(`  control:   ${config.controlPlane?.url ?? '(not set)'}\n`);
    process.stdout.write(`  pid:       ${process.pid}\n`);
    process.stdout.write(`  pidfile:   ${pidPath}\n`);
    process.stdout.write(`  socket:    ${socketPath}\n`);
    process.stdout.write(`  config:    ${configPath}\n`);
    process.stdout.write(`  heartbeat: ${heartbeatMs}ms\n`);
    process.stdout.write(`  poll:      ${pollMs}ms\n`);
    if (!p2pDisabled) {
        process.stdout.write(`  p2p:       ${formatEndpoint(advertisedAddress ?? '-', advertisedPort)}${bindPort !== advertisedPort ? ` (binds locally :${bindPort})` : ''}\n`);
    } else {
        process.stdout.write('  p2p:       disabled\n');
    }
    if (noAdvertise) process.stdout.write('  advertise: off (outbound-only)\n');
    process.stdout.write(`  version:   v${CURRENT_VERSION} (auto-update every ${UPDATE_CHECK_MS / 60_000}min)\n`);

    let heartbeatTimer = null;
    let pollTimer = null;
    let shuttingDown = false;
    let ipcServer = null;
    let p2pServer = null;
    let healthServer = null;
    let p2pConnections = 0;
    let p2pLastConnectionAt = null;

    // Specs cache — re-detection (nvidia-smi, /sys/class/infiniband, Ollama
    // /api/tags) is cheap but not free. Refresh every SPECS_TTL_MS so the
    // control plane sees current served-models / hardware without paying
    // the detection cost on every 30s heartbeat.
    const SPECS_TTL_MS = 5 * 60 * 1000;
    let cachedSpecs = null;
    let cachedSpecsAt = 0;
    // Force the next freshSpecs() to re-detect (served_models etc.) instead of
    // returning the cached copy. Called after any capability change (model
    // install/remove) so the change is advertised on the very next heartbeat.
    const invalidateSpecsCache = () => { cachedSpecs = null; cachedSpecsAt = 0; };

    // Rolling benchmark — last N completed chat jobs' (tokens, duration)
    // pairs. Used to compute tokens_per_second_avg for the heartbeat,
    // which feeds speed-aware routing on the control plane. Capped so
    // memory stays bounded across long-running daemons.
    const BENCH_RING_MAX = 32;
    const benchRing = [];

    function recordBench({ token_count, duration_ms }) {
        if (!Number.isFinite(token_count) || !Number.isFinite(duration_ms) || duration_ms <= 0) return;
        if (token_count <= 0) return;
        benchRing.push({ tokens: token_count, ms: duration_ms, at: Date.now() });
        while (benchRing.length > BENCH_RING_MAX) benchRing.shift();
    }

    function benchSummary() {
        if (benchRing.length === 0) return null;
        const totalTokens = benchRing.reduce((a, e) => a + e.tokens, 0);
        const totalMs = benchRing.reduce((a, e) => a + e.ms, 0);
        if (totalMs <= 0) return null;
        const tps = (totalTokens / totalMs) * 1000;
        return {
            tokens_per_second_avg: +tps.toFixed(2),
            samples: benchRing.length,
            window_started_at: new Date(benchRing[0].at).toISOString()
        };
    }

    /**
     * Reachability self-check — daemon calls /api/probe?host=&port=
     * once after starting the P2P listener. Result cached on the
     * specs object so it ships with heartbeats and surfaces in the
     * dashboard. Refreshed every REACHABILITY_TTL_MS so a router
     * port-forward added later gets picked up without restart.
     */
    const REACHABILITY_TTL_MS = 10 * 60 * 1000;
    let cachedReachable = null;
    let cachedReachableAt = 0;

    async function probeReachable() {
        if (noAdvertise || !advertisedAddress || !p2pPort || p2pDisabled) return null;
        const now = Date.now();
        if (cachedReachable !== null && now - cachedReachableAt < REACHABILITY_TTL_MS) {
            return cachedReachable;
        }
        const baseUrl = config.controlPlane?.url;
        if (!baseUrl) return null;
        try {
            const url = new URL("/api/probe", baseUrl);
            url.searchParams.set("host", advertisedAddress);
            // Probe the externally-advertised port — that's what we're
            // claiming is reachable, so that's what we want verified.
            url.searchParams.set("port", String(advertisedPort));
            const res = await fetch(url, { signal: AbortSignal.timeout?.(7000) });
            if (!res.ok) return null;
            const body = await res.json();
            cachedReachable = {
                ok: !!body.reachable,
                error: body.error ?? null,
                checked_at: new Date(now).toISOString()
            };
            cachedReachableAt = now;
            return cachedReachable;
        } catch {
            return null;
        }
    }

    /**
     * Live load snapshot — fresh on every heartbeat, NOT cached. The
     * picker on the control plane uses this to skip saturated nodes
     * and weight by remaining headroom. Cheap to compute (one
     * nvidia-smi shellout, one os.freemem read) — well worth the
     * cost on each 30s heartbeat compared to the cost of routing a
     * job to a saturated provider that 504s mid-stream.
     */
    async function liveLoad() {
        const host = detectHost();
        const totalRamGb = host.total_ram_mb / 1024;
        const freeRamGb = host.free_ram_mb / 1024;
        let freeVramGb = 0;
        let totalVramGb = 0;
        let maxGpuUtilization = null;
        try {
            const gpus = await detectGpus();
            for (const g of gpus) {
                if (Number.isFinite(g.vram_mb)) totalVramGb += g.vram_mb / 1024;
                if (Number.isFinite(g.vram_mb) && Number.isFinite(g.vram_used_mb)) {
                    freeVramGb += Math.max(0, (g.vram_mb - g.vram_used_mb) / 1024);
                }
                if (Number.isFinite(g.utilization)) {
                    maxGpuUtilization = Math.max(maxGpuUtilization ?? 0, g.utilization);
                }
            }
        } catch {
            // Best-effort; CPU-only boxes report zero GPU stats.
        }
        return {
            active_jobs: stats.activeJobIds.size,
            load_avg_1m: Array.isArray(host.load_avg) ? +host.load_avg[0]?.toFixed(2) : null,
            ram: {
                total_gb: +totalRamGb.toFixed(2),
                free_gb: +freeRamGb.toFixed(2)
            },
            vram: {
                total_gb: +totalVramGb.toFixed(2),
                free_gb: +freeVramGb.toFixed(2)
            },
            gpu_utilization_max: maxGpuUtilization,
            measured_at: new Date().toISOString()
        };
    }

    async function freshSpecs() {
        if (node.role !== 'provider') return null;
        const now = Date.now();
        let base;
        if (cachedSpecs && now - cachedSpecsAt < SPECS_TTL_MS) {
            base = cachedSpecs;
        } else {
            try {
                cachedSpecs = await gatherCoarseSpecs();
                cachedSpecsAt = now;
                base = cachedSpecs;
            } catch (err) {
                process.stderr.write(`specs detection failed: ${err?.message ?? err}\n`);
                base = cachedSpecs;
            }
        }
        if (!base) return null;
        // Always re-read load (cheap, must be current). bench rolls
        // independently as jobs complete. reachability has its own
        // TTL so we don't hammer /api/probe on every heartbeat.
        const bench = benchSummary();
        const load = await liveLoad();
        const reachable = await probeReachable();

        // IPIP-0028: ensure a keypair exists for each served model and
        // advertise their pubkeys so consumers can encrypt to model keys.
        let modelKeys = {};
        try {
            const servedModels = Array.isArray(base.served_models) ? base.served_models : [];
            for (const name of servedModels) {
                const kp = await getOrCreateModelKey(name);
                if (kp?.publicKey) modelKeys[name] = kp.publicKey;
            }
        } catch {
            // non-fatal — fall back to empty model_keys
        }

        // IPIP-0033: read the inference state file (written by
        // `infernet inference serve --backend rpc` / `infernet
        // inference primary`) and surface the current rpc / rpc_primary
        // capabilities. Heartbeats are how the control plane learns
        // which models a node is willing to slice or drive.
        const inf = await readInferenceState();
        const rpcSlice = inf?.rpc_slice;
        const rpcAdvert =
            rpcSlice && Array.isArray(rpcSlice.models) && rpcSlice.models.length > 0
                && (rpcSlice.pid == null || isPidAlive(rpcSlice.pid))
                ? {
                    rpc: {
                        engine: 'llama.cpp',
                        version: CURRENT_VERSION,
                        models: rpcSlice.models,
                        host: rpcSlice.host ?? null,
                        port: rpcSlice.port ?? null,
                        vram_gb: rpcSlice.vram_gb ?? null,
                        ram_gb: rpcSlice.ram_gb ?? null,
                        max_concurrent: rpcSlice.max_concurrent ?? 1
                    }
                }
                : {};

        const rpcPrimary = inf?.rpc_primary;
        const primaryAdvert =
            rpcPrimary && Array.isArray(rpcPrimary.models) && rpcPrimary.models.length > 0
                ? {
                    rpc_primary: {
                        engine: 'llama.cpp',
                        version: CURRENT_VERSION,
                        models: rpcPrimary.models
                    }
                }
                : {};

        return {
            ...base,
            ...(bench ? { bench } : {}),
            load,
            ...(reachable ? { reachable } : {}),
            ...(Object.keys(modelKeys).length > 0 ? { model_keys: modelKeys } : {}),
            ...rpcAdvert,
            ...primaryAdvert,
            public_key: config?.node?.publicKey ?? undefined,
            cli_version: CURRENT_VERSION
        };
    }

    async function heartbeat() {
        const payload = { status: 'available' };
        if (!noAdvertise) {
            if (advertisedAddress) payload.address = advertisedAddress;
            // Heartbeat advertises the EXTERNAL port (what clients should
            // dial), not the internal bind port. RunPod / NAT'd hosts:
            // bindPort = 46337 (container), advertisedPort = 21517 (edge).
            if (!p2pDisabled) payload.port = advertisedPort;
        }
        // Provider role only: include current specs so the control plane
        // sees fresh CPU / GPU / served_models without requiring a manual
        // `infernet register` after each capability change.
        const specs = await freshSpecs();
        if (specs) payload.specs = specs;
        try {
            await client.heartbeat(payload);
            stats.heartbeatsOk += 1;
            stats.lastHeartbeatAt = new Date().toISOString();
            stats.lastHeartbeatError = null;
            process.stdout.write(`[${stats.lastHeartbeatAt}] heartbeat ok\n`);
        } catch (err) {
            stats.heartbeatsFailed += 1;
            stats.lastHeartbeatError = err?.message ?? String(err);
            process.stderr.write(`heartbeat error: ${stats.lastHeartbeatError}\n`);
        }
    }

    async function processJob(job) {
        const t0 = new Date().toISOString();
        stats.jobsPicked += 1;
        stats.activeJobIds.add(job.id);
        stats.lastJobAt = t0;
        process.stdout.write(`[${t0}] picking up job ${job.id} type=${job.type ?? 'inference'} (${job.title ?? 'untitled'})\n`);

        try {
            let resultPayload;
            if (job.type === 'chat') {
                const result = await executeChatJob({ client, job, node });
                recordBench(result);
                resultPayload = {
                    type: 'chat',
                    text: result.text,
                    token_count: result.token_count,
                    duration_ms: result.duration_ms,
                    completed_by: node.nodeId
                };
            } else {
                await new Promise((resolve) => setTimeout(resolve, 500));
                resultPayload = { stub: true, completed_by: node.nodeId };
            }
            await client.completeJob(job.id, { status: 'completed', result: resultPayload });
            stats.jobsCompleted += 1;
            stats.activeJobIds.delete(job.id);
            process.stdout.write(`[${new Date().toISOString()}] completed job ${job.id} type=${job.type ?? 'inference'}\n`);
        } catch (err) {
            stats.jobsFailed += 1;
            stats.activeJobIds.delete(job.id);
            const msg = err?.message ?? String(err);
            process.stderr.write(`job ${job.id} failed: ${msg}\n`);
            if (job.type === 'chat') {
                await failChatJob({ client, jobId: job.id, message: msg });
            }
            try {
                await client.failJob(job.id, msg);
            } catch (markErr) {
                process.stderr.write(`failJob failed: ${markErr?.message ?? markErr}\n`);
            }
        }
    }

    async function pollJobs() {
        stats.lastPollAt = new Date().toISOString();
        if (node.role !== 'provider') {
            stats.pollsOk += 1;
            return;
        }
        if (stats.draining) return;
        try {
            const result = await client.pollJobs({ limit: 5 });
            stats.pollsOk += 1;
            for (const job of result?.jobs ?? []) {
                // Skip jobs already being processed by this daemon — the
                // server keeps returning 'assigned' jobs until we mark them
                // complete, so without this guard the poll loop queues the
                // same job on every tick while it's in flight.
                if (stats.activeJobIds.has(job.id)) continue;
                await processJob(job);
            }
        } catch (err) {
            stats.pollsFailed += 1;
            process.stderr.write(`job poll error: ${err?.message ?? err}\n`);
        }
    }

    /**
     * Owner-issued node commands (model_install / model_remove). Same
     * outbound-poll pattern as jobs — no inbound connectivity needed.
     * Auth at the server side: only owners (verified via pubkey_links)
     * can write to node_commands; the daemon's signed poll restricts
     * which rows it sees by pubkey match. So a compromised dashboard
     * account can only push commands to nodes that account already
     * owns; a compromised daemon key can only execute commands
     * targeting itself.
     */
    async function pollNodeCommands() {
        if (node.role !== 'provider') return;
        let result;
        try {
            result = await client.pollCommands(5);
        } catch (err) {
            process.stderr.write(`command poll error: ${err?.message ?? err}\n`);
            return;
        }
        for (const cmd of result?.commands ?? []) {
            await runNodeCommand(cmd);
        }
    }

    /**
     * IPIP-0030: poll the open training market, claim a shard if any
     * fit our hardware, run it via runTrainShard, report back. Single
     * shard per poll cycle — keeps a node from monopolizing a job.
     */
    let trainingBusy = false;
    async function pollTrainingMarket() {
        if (node.role !== 'provider') return;
        if (trainingBusy) return; // one at a time

        let listing;
        try {
            listing = await client.listAvailableTrainingShards(3);
        } catch (err) {
            process.stderr.write(`training market poll error: ${err?.message ?? err}\n`);
            return;
        }
        const shards = listing?.shards ?? [];
        if (shards.length === 0) return;

        // Race-claim the first one. If another node beats us, just exit;
        // we'll retry on the next poll cycle.
        let claimed = null;
        for (const shard of shards) {
            try {
                const res = await client.claimTrainingShard(shard.shard_id);
                claimed = res;
                break;
            } catch (err) {
                if (err?.status === 409) continue; // someone else got it
                process.stderr.write(`training claim error: ${err?.message ?? err}\n`);
            }
        }
        if (!claimed) return;

        trainingBusy = true;
        const shardId = claimed.shard_id;
        process.stdout.write(
            `[training] claimed shard ${shardId} of job ${claimed.job_id} ` +
            `(base ${claimed.base_model}, idx ${claimed.shard_index})\n`
        );
        const t0 = Date.now();
        try {
            // Reuse the same daemon-side handler used by node_commands.
            const result = await runTrainShard({
                shard_url: claimed.shard_url,
                upload_url: claimed.upload_url,
                base_model: claimed.base_model,
                ...(claimed.config ?? {})
            }, shardId);
            await client.reportTrainingShard(shardId, {
                status: 'completed',
                adapter_url: result?.uploaded ? claimed.upload_url : null,
                metrics: { duration_ms: Date.now() - t0 }
            });
            process.stdout.write(`[training] reported completed shard ${shardId}\n`);
        } catch (err) {
            const msg = err?.message ?? String(err);
            process.stderr.write(`[training] shard ${shardId} failed: ${msg}\n`);
            try {
                await client.reportTrainingShard(shardId, { status: 'failed', error: msg });
            } catch { /* swallow */ }
        } finally {
            trainingBusy = false;
        }
    }

    async function runNodeCommand(cmd) {
        const { id, command, args } = cmd;
        const t0 = new Date().toISOString();
        process.stdout.write(`[${t0}] running command ${id}: ${command} ${JSON.stringify(args)}\n`);
        try {
            let result;
            if (command === 'model_install') {
                const modelName = String(args?.model);
                // The node decides the backend by HARDWARE: prefer vLLM (GPU),
                // fall back to Ollama (CPU/Mac). A catalog model carries an
                // `hf` repo (ungated, vLLM-servable); a bare `hf:` name is
                // vLLM-only; everything else is an Ollama tag.
                const hfRepo = args?.hf
                    ? String(args.hf)
                    : (modelName.startsWith('hf:') ? modelName.slice(3) : null);

                if (vllmInstalled() && hfRepo) {
                    // GPU path — serve the HF weights on vLLM. Keep the friendly
                    // name (e.g. "qwen2.5:7b" or "hf:org/repo") as the served
                    // model name so chat requests + served_models match, but the
                    // engine underneath is vLLM.
                    const token = process.env.HF_TOKEN || (await resolveHfToken().catch(() => null));
                    // Step 1/3 — download weights.
                    await client.updateCommandProgress(id, {
                        phase: 'download', step: 1, steps: 3, status: 'downloading weights'
                    }).catch(() => {});
                    const localPath = await downloadHfModel(hfRepo, token);
                    // Don't report "completed" on spawn — wait until vLLM has
                    // mapped the weights and /v1/models actually lists the model.
                    // If it never comes up (OOM, unsupported arch, gated repo),
                    // fail the command WITH the log root cause instead of lying.
                    // Step 2/3 — start the engine + wait for it to serve.
                    await client.updateCommandProgress(id, {
                        phase: 'serve', step: 2, steps: 3, status: 'starting vLLM engine', pct: 0
                    }).catch(() => {});
                    const serve = await startVllmServe({ source: hfRepo, servedName: modelName, token });
                    process.stdout.write(`[${new Date().toISOString()}] ${modelName} (${hfRepo}) downloaded; waiting for vLLM to load weights…\n`);
                    // Auto-cancel ceiling: give up after VLLM_INSTALL_TIMEOUT_S
                    // (default 10 min). Each tick reports progress AND checks
                    // whether the owner cancelled (the progress response echoes
                    // the command status) so a stuck install can be stopped.
                    const vllmWaitMs = Number(process.env.VLLM_INSTALL_TIMEOUT_S || 600) * 1000;
                    const up = await waitForVllmModel(modelName, {
                        pid: serve.pid,
                        timeoutMs: vllmWaitMs,
                        onTick: async ({ elapsedMs, timeoutMs }) => {
                            const pct = Math.min(99, Math.round((elapsedMs / timeoutMs) * 100));
                            const resp = await client.updateCommandProgress(id, {
                                phase: 'serve', step: 2, steps: 3, status: 'starting vLLM engine', pct
                            }).catch(() => null);
                            if (resp?.status === 'cancelled') return 'cancel';
                        }
                    });
                    if (up.cancelled) {
                        await stopVllmServe().catch(() => {});
                        invalidateSpecsCache();
                        process.stdout.write(`[${new Date().toISOString()}] ${modelName} install cancelled — stopped vLLM\n`);
                        return; // status is already 'cancelled'; don't complete
                    }
                    if (!up.serving) {
                        await stopVllmServe().catch(() => {});
                        const tail = await extractVllmError();
                        throw new Error(
                            `vLLM failed to serve ${modelName} (${hfRepo}): ${up.reason}.` +
                            (tail ? `\n--- vllm.log (root cause) ---\n${tail}` : ' (no vllm.log output)')
                        );
                    }
                    // Step 3/3 — serving.
                    await client.updateCommandProgress(id, {
                        phase: 'serve', step: 3, steps: 3, status: 'serving', pct: 100
                    }).catch(() => {});
                    invalidateSpecsCache();
                    result = {
                        model: modelName,
                        backend: 'vllm',
                        source: hfRepo,
                        localPath,
                        vllm: { pid: serve.pid, port: serve.port },
                        note: `Serving on vLLM :${serve.port} and advertised in served_models.`,
                    };
                } else if (modelName.startsWith('hf:')) {
                    // hf: model requested but this node has no vLLM (CPU/Mac).
                    throw new Error(
                        `${modelName} needs vLLM, which isn't installed on this node. ` +
                        `Re-run the installer on an NVIDIA host (it installs vLLM), or: pip install vllm. ` +
                        `Alternatively push an Ollama model — those run on CPU.`
                    );
                } else {
                    // CPU/Mac path (or a GPU box without a vLLM-servable repo) —
                    // Ollama serves the GGUF tag.
                    const fits = await checkModelFits(modelName);
                    if (fits && !fits.ok) {
                        throw new Error(formatFitFailure(modelName, fits));
                    }
                    result = await ollamaPullWithProgress(modelName, id);
                    invalidateSpecsCache();
                }
            } else if (command === 'model_remove') {
                result = await ollamaSpawn(['rm', String(args?.model)]);
                invalidateSpecsCache();
            } else if (command === 'train_shard') {
                result = await runTrainShard(args, id);
            } else {
                throw new Error(`unknown command verb: ${command}`);
            }
            await client.completeCommand(id, { status: 'completed', result });
            process.stdout.write(`[${new Date().toISOString()}] completed command ${id}\n`);
            // Push the capability change immediately — don't wait up to 30s for
            // the next scheduled heartbeat. freshSpecs() re-detects because the
            // cache was invalidated above, so served_models reflects the change
            // and the model shows in "Installed on node" + /chat right away.
            heartbeat().catch(() => { /* next scheduled beat will retry */ });
        } catch (err) {
            const msg = err?.message ?? String(err);
            process.stderr.write(`command ${id} failed: ${msg}\n`);
            try {
                await client.completeCommand(id, { status: 'failed', error: msg });
            } catch (markErr) {
                process.stderr.write(`completeCommand failed: ${markErr?.message ?? markErr}\n`);
            }
        }
    }

    /**
     * Run an `ollama` subcommand non-interactively, capturing stdout
     * and stderr. Returns { stdout, stderr, code } on success; throws
     * on non-zero exit so the command queue records a failure.
     */
    function ollamaSpawn(args) {
        return new Promise((resolve, reject) => {
            const child = spawn('ollama', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            child.stdout.on('data', (b) => { out += b.toString(); });
            child.stderr.on('data', (b) => { err += b.toString(); });
            child.on('error', (e) => reject(new Error(`ollama spawn error: ${e?.message ?? e}`)));
            child.on('exit', (code) => {
                if (code === 0) resolve({ stdout: out.slice(-4096), stderr: err.slice(-4096), code });
                else reject(new Error(`ollama exited ${code}: ${(err || out).slice(-512)}`));
            });
        });
    }

    /**
     * Pull a model via Ollama's HTTP API (POST /api/pull) so we can
     * stream progress JSON and post throttled updates to the control
     * plane. The web dashboard renders a progress bar from those
     * updates.
     *
     * Each NDJSON line looks like:
     *   {"status":"pulling manifest"}
     *   {"status":"downloading","digest":"sha256:abc","total":1234,"completed":456}
     *   {"status":"verifying sha256 digest"}
     *   {"status":"success"}
     */
    async function ollamaPullWithProgress(modelName, commandId) {
        const ollamaHost = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
        const url = new URL('/api/pull', ollamaHost);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: modelName, stream: true })
        });
        if (!res.ok || !res.body) {
            throw new Error(`ollama pull HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastPostMs = 0;
        let lastStatus = null;
        let finalLine = null;
        const POST_THROTTLE_MS = 2000;

        const postProgress = async (line) => {
            try {
                const safe = {
                    status: typeof line.status === 'string' ? line.status : null,
                    total: Number.isFinite(line.total) ? line.total : null,
                    completed: Number.isFinite(line.completed) ? line.completed : null,
                    pct: (Number.isFinite(line.total) && Number.isFinite(line.completed) && line.total > 0)
                        ? Math.round((line.completed / line.total) * 100)
                        : null
                };
                await client.updateCommandProgress(commandId, safe);
            } catch (err) {
                // Don't fail the pull on a progress-post hiccup.
                process.stderr.write(`progress post failed: ${err?.message ?? err}\n`);
            }
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const raw = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!raw) continue;
                let line;
                try { line = JSON.parse(raw); } catch { continue; }
                finalLine = line;
                if (line.error) throw new Error(`ollama: ${line.error}`);

                // Post when status changes (manifest → downloading → verifying →
                // success) OR when we've been on the same status long enough.
                const now = Date.now();
                const statusChanged = line.status !== lastStatus;
                if (statusChanged || (now - lastPostMs) > POST_THROTTLE_MS) {
                    lastStatus = line.status;
                    lastPostMs = now;
                    await postProgress(line);
                }
            }
        }
        // Final 100% post on success.
        if (finalLine?.status === 'success' || (finalLine && !finalLine.error)) {
            await postProgress({ status: 'success', total: 1, completed: 1 });
        }
        return { stdout: 'pulled via /api/pull', code: 0 };
    }

    /**
     * Daemon-side handler for the `train_shard` command verb (federated
     * LoRA). Pulls a JSONL shard from a public URL, runs the same Unsloth
     * script the operator's local mode uses, and returns a path to the
     * resulting adapter so the coordinator can FedAvg it.
     *
     * EXPERIMENTAL: assumes Python + Unsloth + datasets + trl are
     * installed on the node. Future: bundle a thin Python venv at setup
     * time so this works out of the box. Adapter upload is currently
     * "report local path" — for cross-machine training the operator needs
     * to provide an args.upload_url that we POST the safetensors to.
     */
    async function runTrainShard(args, _commandId) {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const { buildUnslothScript } = await import('../lib/training/unsloth-script.js');

        if (!args?.shard_url) throw new Error('train_shard: args.shard_url required');
        if (!args?.base_model) throw new Error('train_shard: args.base_model required');

        const runId = args.run_id ?? `shard-${Date.now()}`;
        const workDir = path.join(process.env.HOME ?? '/tmp', '.infernet', 'training', runId);
        await fs.mkdir(workDir, { recursive: true });

        // Download the shard
        const shardPath = path.join(workDir, 'shard.jsonl');
        const res = await fetch(args.shard_url);
        if (!res.ok) throw new Error(`fetch shard: HTTP ${res.status}`);
        const text = await res.text();
        await fs.writeFile(shardPath, text);

        // Build + run the Unsloth script
        const trainConfig = {
            base_model: args.base_model,
            training: args.training ?? {},
            lora: args.lora ?? {},
            input: { dataset: shardPath }
        };
        const scriptPath = path.join(workDir, 'unsloth_runner.py');
        await fs.writeFile(scriptPath, buildUnslothScript({ trainConfig }));

        await new Promise((resolve, reject) => {
            const child = spawn('python3', [scriptPath, '--data', shardPath, '--output', workDir], {
                stdio: 'inherit'
            });
            child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`unsloth_runner exited ${code}`)));
            child.on('error', reject);
        });

        const adapterDir = path.join(workDir, 'checkpoint-final');

        // Optional: upload adapter back to the operator-provided URL
        if (args.upload_url) {
            const adapterFile = path.join(adapterDir, 'adapter_model.safetensors');
            const buf = await fs.readFile(adapterFile);
            const up = await fetch(args.upload_url, {
                method: 'PUT',
                body: buf,
                headers: { 'Content-Type': 'application/octet-stream' }
            });
            if (!up.ok) throw new Error(`upload adapter: HTTP ${up.status}`);
        }

        return {
            adapter_path: adapterDir,
            uploaded: !!args.upload_url,
            shard_url: args.shard_url
        };
    }

    /**
     * IPIP-0033 §4 — primary-side federated-inference endpoint.
     *
     *   POST /v1/rpc/inference
     *   body: {
     *     model, messages,
     *     max_tokens?, temperature?,
     *     rpc_peers: [{ host, port, pubkey }, ...]
     *   }
     *   response: text/event-stream with meta / routing / token /
     *             log / done / error frames matching the IPIP shape.
     *
     * The handler spawns `llama-server --rpc h1:p1,h2:p2,...
     * --model <local_gguf_path>`, streams its OpenAI-compatible
     * `/v1/chat/completions` response back as SSE tokens, and emits
     * a routing frame as soon as it has parsed enough stderr to know
     * which slice owns which layers.
     */
    async function handleRpcInference(req, res) {
        if (req.method !== 'POST' || req.url !== '/v1/rpc/inference') return false;

        const { spawnLlamaServer, streamChatCompletion, aggregateLayerAssignments } =
            await import('@infernetprotocol/rpc-adapter');

        let body = '';
        await new Promise((resolve, reject) => {
            req.on('data', (chunk) => { body += chunk.toString(); });
            req.on('end', resolve);
            req.on('error', reject);
        });
        let payload;
        try { payload = JSON.parse(body); } catch {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('bad json\n');
            return true;
        }

        const { model, messages, max_tokens, temperature, rpc_peers } = payload ?? {};
        if (!model || !Array.isArray(messages) || !Array.isArray(rpc_peers)) {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('model + messages[] + rpc_peers[] required\n');
            return true;
        }

        // Resolve the GGUF path. The primary command writes the
        // mapping (model_id → absolute path) into the inference state
        // file; fall back to ~/.infernet/models/<id>.gguf for the
        // ad-hoc case.
        const path = await import('node:path');
        const fsp = await import('node:fs/promises');
        const inf = await readInferenceState();
        let modelPath = inf?.rpc_primary?.gguf_paths?.[model] ?? null;
        if (!modelPath) {
            modelPath = model.startsWith('/')
                ? model
                : path.join(process.env.HOME ?? '/tmp', '.infernet', 'models', `${model}.gguf`);
        }
        try {
            await fsp.access(modelPath);
        } catch {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end(`gguf not found at ${modelPath}\n`);
            return true;
        }

        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-accel-buffering': 'no'
        });

        const writeFrame = (event, data) => {
            try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
            catch { /* socket closed */ }
        };

        let handle;
        try {
            handle = await spawnLlamaServer({
                modelPath,
                rpcPeers: rpc_peers,
                host: '127.0.0.1',
                port: 0
            });
        } catch (err) {
            writeFrame('error', { message: `spawnLlamaServer: ${err?.message ?? err}` });
            res.end();
            return true;
        }

        // Collect parsed events while waiting for ready. The
        // aggregator consumes layer_assigned + peer_connected +
        // peer_failed events together so per-peer status reflects
        // the current lifecycle, not just the layer roll-up.
        const peerEvents = [];
        let routingEmitted = false;
        let lastRoutingSig = '';
        const flushRouting = () => {
            const peers = aggregateLayerAssignments(peerEvents);
            // Skip emit when nothing changed — saves SSE bandwidth +
            // duplicate UI re-renders. Cheap stable signature.
            const sig = peers
                .map((p) => `${p.host}:${p.port}|${p.layers.start}-${p.layers.end}|${p.status}|${p.reason ?? ''}`)
                .sort()
                .join(';');
            if (sig === lastRoutingSig) return;
            lastRoutingSig = sig;
            writeFrame('routing', { peers });
            routingEmitted = true;
        };

        // Pipe all parsed events out as `log` frames (except routing)
        // so the control plane gets full diagnostic visibility, and
        // immediately re-flush routing on any peer-state change so
        // the chat UI sees a 'dropped' tag the moment llama.cpp
        // reports it.
        const eventDrain = (async () => {
            for await (const ev of handle.events()) {
                if (ev.type === 'layer_assigned') {
                    peerEvents.push(ev);
                    if (routingEmitted) flushRouting();
                } else if (ev.type === 'server_ready') {
                    if (!routingEmitted) flushRouting();
                } else if (ev.type === 'log') {
                    writeFrame('log', { text: ev.text });
                } else if (ev.type === 'peer_connected' || ev.type === 'peer_failed') {
                    peerEvents.push(ev);
                    writeFrame('log', { event: ev.type, ...ev });
                    flushRouting();
                } else if (ev.type === 'load_progress') {
                    writeFrame('log', { event: ev.type, ...ev });
                }
            }
        })().catch((err) => writeFrame('log', { warn: `events drain: ${err?.message ?? err}` }));

        let serverInfo;
        try {
            serverInfo = await handle.ready;
        } catch (err) {
            writeFrame('error', { message: err?.message ?? String(err) });
            res.end();
            return true;
        }

        // Periodically re-flush routing in case more layer events come
        // in after server_ready (some llama.cpp builds log assignments
        // lazily as tensors are first touched).
        const routingTimer = setInterval(flushRouting, 5000);
        if (typeof routingTimer.unref === 'function') routingTimer.unref();

        const baseUrl = `http://${serverInfo.host}:${serverInfo.port}`;
        try {
            for await (const ev of streamChatCompletion({
                baseUrl,
                model,
                messages,
                maxTokens: max_tokens,
                temperature
            })) {
                if (ev.type === 'meta') continue; // emitted by control plane
                writeFrame(ev.type, ev.data);
                if (ev.type === 'done' || ev.type === 'error') break;
            }
        } catch (err) {
            writeFrame('error', { message: err?.message ?? String(err) });
        } finally {
            clearInterval(routingTimer);
            handle.kill();
            await eventDrain.catch(() => {});
            res.end();
        }
        return true;
    }

    /**
     * Daemon-side peer census for the rpc-adapter (IPIP-0033 — llama.cpp
     * RPC peer assignment).
     *
     *   GET /v1/rpc/census?model=<id>[&kind=rpc|model|class]
     *   response: { kind, value, count, peers, dht, note? }
     *
     * Peer discovery used to come from the daemon's own Hyperswarm DHT
     * (IPIP-0032). That layer has been moved to c0mpute. Until the
     * c0mpute-backed query is wired in, this endpoint always returns
     * `count: 0` with a note — the chat client falls back to
     * control-plane routing.
     */
    async function handleRpcCensus(req, res) {
        if (req.method !== 'GET') return false;
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/v1/rpc/census') return false;

        const model = url.searchParams.get('model');
        const kind = url.searchParams.get('kind') ?? 'rpc';
        if (!model) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'model query param is required' }));
            return true;
        }

        // Peer discovery has moved to c0mpute (libp2p Kad-DHT +
        // gossipsub capability ads). Until the c0mpute-backed query
        // is wired in, return an empty list with a note so the chat
        // client falls back to control-plane routing.
        const body = {
            kind,
            value: model,
            count: 0,
            peers: [],
            dht: false,
            note: 'peer discovery moved to c0mpute; query c0mpute capability registry instead'
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        return true;
    }

    /**
     * IPIP-0030: shard-hosting routes layered on top of /healthz.
     * Returns true if the request matched and was handled.
     */
    async function handleTrainingHttp(req, res) {
        if (!req.url) return false;
        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;

        // GET /v1/training/shards/<run_id>/<shard_index>.jsonl
        const shardMatch = pathname.match(/^\/v1\/training\/shards\/([A-Za-z0-9_-]+)\/shard-(\d+)\.jsonl$/);
        if (shardMatch && req.method === 'GET') {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const [, runId, idx] = shardMatch;
            const filePath = path.join(
                process.env.HOME ?? '/tmp',
                '.infernet', 'training-runs', runId, 'shards', `shard-${idx}.jsonl`
            );
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'content-type': 'text/plain' });
                res.end('shard not found\n');
                return true;
            }
            res.writeHead(200, {
                'content-type': 'application/jsonl',
                'content-length': fs.statSync(filePath).size,
                'cache-control': 'no-store'
            });
            fs.createReadStream(filePath).pipe(res);
            return true;
        }

        // PUT /v1/training/adapters/<run_id>/<shard_index>?token=<t>
        const adapterMatch = pathname.match(/^\/v1\/training\/adapters\/([A-Za-z0-9_-]+)\/(\d+)$/);
        if (adapterMatch && req.method === 'PUT') {
            const fsp = await import('node:fs/promises');
            const fs = await import('node:fs');
            const path = await import('node:path');
            const [, runId, idx] = adapterMatch;
            const runDir = path.join(process.env.HOME ?? '/tmp', '.infernet', 'training-runs', runId);
            const manifestPath = path.join(runDir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) {
                res.writeHead(404, { 'content-type': 'text/plain' });
                res.end('run not found\n');
                return true;
            }
            // Token check: only accept PUTs whose ?token=<t> matches the
            // run's manifest. The submitter mints the token at run-start
            // and shares it with the control plane only via upload_url.
            const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
            const presentedToken = url.searchParams.get('token');
            if (!presentedToken || presentedToken !== manifest.upload_token) {
                res.writeHead(403, { 'content-type': 'text/plain' });
                res.end('bad token\n');
                return true;
            }
            const adapterDir = path.join(runDir, 'adapters');
            await fsp.mkdir(adapterDir, { recursive: true });
            const outPath = path.join(adapterDir, `shard-${idx}.adapter.safetensors`);
            await new Promise((resolve, reject) => {
                const ws = fs.createWriteStream(outPath);
                req.pipe(ws);
                ws.on('finish', resolve);
                ws.on('error', reject);
                req.on('error', reject);
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, path: outPath }));
            return true;
        }

        return false;
    }

    function snapshot() {
        return {
            pid: process.pid,
            startedAt: startedAt.toISOString(),
            uptimeMs: Date.now() - startedAt.getTime(),
            node: {
                nodeId: node.nodeId,
                id: node.id,
                role: node.role,
                name: node.name ?? null
            },
            controlPlaneUrl: config.controlPlane?.url ?? null,
            intervals: { heartbeatMs, pollMs },
            stats: {
                heartbeatsOk: stats.heartbeatsOk,
                heartbeatsFailed: stats.heartbeatsFailed,
                lastHeartbeatAt: stats.lastHeartbeatAt,
                lastHeartbeatError: stats.lastHeartbeatError,
                jobsPicked: stats.jobsPicked,
                jobsCompleted: stats.jobsCompleted,
                jobsFailed: stats.jobsFailed,
                activeJobs: stats.activeJobIds.size,
                activeJobIds: Array.from(stats.activeJobIds),
                lastJobAt: stats.lastJobAt,
                pollsOk: stats.pollsOk,
                pollsFailed: stats.pollsFailed,
                lastPollAt: stats.lastPollAt
            },
            p2p: p2pDisabled ? { enabled: false } : {
                enabled: true,
                port: p2pPort,
                address: advertisedAddress,
                endpoint: formatEndpoint(advertisedAddress ?? '-', p2pPort),
                connectionsTotal: p2pConnections,
                lastConnectionAt: p2pLastConnectionAt
            }
        };
    }

    function startIpcServer() {
        return new Promise((resolve, reject) => {
            const server = net.createServer((sock) => {
                let buf = '';
                sock.setEncoding('utf8');
                sock.on('data', async (chunk) => {
                    buf += chunk;
                    for (;;) {
                        const nl = buf.indexOf('\n');
                        if (nl < 0) break;
                        const line = buf.slice(0, nl);
                        buf = buf.slice(nl + 1);
                        let msg;
                        try { msg = JSON.parse(line); }
                        catch (err) {
                            sock.write(JSON.stringify({ ok: false, error: 'bad-json', cause: err?.message ?? String(err) }) + '\n');
                            continue;
                        }
                        const reply = await handleIpc(msg);
                        try { sock.write(JSON.stringify(reply) + '\n'); } catch { /* ignore */ }
                    }
                });
                sock.on('error', () => {});
            });
            server.once('error', reject);
            server.listen(socketPath, () => {
                try { chmodSync(socketPath, 0o600); } catch { /* ignore */ }
                resolve(server);
            });
        });
    }

    async function handleIpc(msg) {
        const cmd = msg?.cmd;
        switch (cmd) {
            case 'ping':    return { ok: true, data: { pong: Date.now() } };
            case 'status':
            case 'stats':   return { ok: true, data: snapshot() };
            case 'shutdown':
                setImmediate(() => shutdown('ipc-shutdown'));
                return { ok: true, data: { shuttingDown: true } };
            default:
                return { ok: false, error: `unknown-cmd: ${cmd ?? '(none)'}` };
        }
    }

    function startP2pServer() {
        return new Promise((resolve, reject) => {
            const server = net.createServer((sock) => {
                p2pConnections += 1;
                p2pLastConnectionAt = new Date().toISOString();
                sock.setEncoding('utf8');
                let buf = '';
                sock.on('data', async (chunk) => {
                    buf += chunk;
                    for (;;) {
                        const nl = buf.indexOf('\n');
                        if (nl < 0) break;
                        const line = buf.slice(0, nl);
                        buf = buf.slice(nl + 1);
                        let msg;
                        try { msg = JSON.parse(line); }
                        catch (err) {
                            try { sock.write(JSON.stringify({ ok: false, error: 'bad-json', cause: err?.message ?? String(err) }) + '\n'); } catch { /* ignore */ }
                            continue;
                        }
                        let reply;
                        switch (msg?.cmd) {
                            case 'ping':
                                reply = { ok: true, data: { pong: Date.now(), node_id: node.nodeId } };
                                break;
                            case 'info':
                                reply = { ok: true, data: {
                                    node_id: node.nodeId,
                                    role: node.role,
                                    name: node.name ?? null,
                                    port: p2pPort
                                } };
                                break;
                            default:
                                reply = { ok: false, error: `unknown-cmd: ${msg?.cmd ?? '(none)'}` };
                        }
                        try { sock.write(JSON.stringify(reply) + '\n'); } catch {}
                    }
                });
                sock.on('error', () => {});
            });
            server.once('error', reject);
            server.listen({ port: p2pPort, host: '::', ipv6Only: false }, () => {
                resolve(server);
            });
        });
    }

    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stdout.write(`\nReceived ${signal}; shutting down...\n`);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (pollTimer) clearInterval(pollTimer);
        try {
            await client.heartbeat({ status: 'offline' });
        } catch (err) {
            process.stderr.write(`offline heartbeat failed: ${err?.message ?? err}\n`);
        }
        if (ipcServer) { try { ipcServer.close(); } catch {} }
        if (p2pServer) { try { p2pServer.close(); } catch {} }
        if (healthServer) { try { healthServer.close(); } catch {} }
        try { await shutdownEngine(); } catch {}
        removeSocketFile();
        await removePidFile();
        process.stdout.write('bye\n');
        process.exit(0);
    };

    process.on('SIGINT',  () => { shutdown('SIGINT');  });
    process.on('SIGTERM', () => { shutdown('SIGTERM'); });

    try {
        ipcServer = await startIpcServer();
        process.stdout.write(`IPC listening on ${socketPath}\n`);
    } catch (err) {
        process.stderr.write(`Failed to bind IPC socket at ${socketPath}: ${err?.message ?? err}\n`);
    }

    // Peer discovery (formerly Hyperswarm DHT, IPIP-0032) has moved
    // to c0mpute's libp2p Kad-DHT + gossipsub. The infernet daemon no
    // longer maintains its own discovery bridge — workers advertise
    // capabilities via the c0mpute supervisor and the chat client
    // routes through the control plane until c0mpute-backed query
    // is wired in.

    // /healthz — bind a tiny HTTP server on $PORT (default 8080) so
    // Docker / Runpod / Kubernetes HEALTHCHECK probes can reach the
    // daemon even though the main daemon's port is 46337 (P2P, often
    // firewalled). Returns 200 + a JSON daemon snapshot.
    const healthPort = Number.parseInt(process.env.PORT ?? '', 10) || 8080;
    try {
        healthServer = http.createServer(async (req, res) => {
            if (req.url === '/healthz' || req.url === '/health' || req.url === '/') {
                const snap = snapshot();
                const body = JSON.stringify({
                    ok: true,
                    pid: snap.pid,
                    uptime_ms: snap.uptimeMs,
                    role: snap.node?.role ?? null,
                    node_id: snap.node?.nodeId ?? null,
                    control_plane: snap.controlPlaneUrl,
                    heartbeats_ok: snap.stats?.heartbeatsOk ?? 0,
                    heartbeats_failed: snap.stats?.heartbeatsFailed ?? 0,
                    last_heartbeat_at: snap.stats?.lastHeartbeatAt ?? null,
                    last_heartbeat_error: snap.stats?.lastHeartbeatError ?? null,
                    jobs_completed: snap.stats?.jobsCompleted ?? 0,
                    jobs_failed: snap.stats?.jobsFailed ?? 0,
                    active_jobs: stats.activeJobIds.size
                });
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                res.end(body);
                return;
            }

            // IPIP-0030: serve training shards directly from this node's
            // local filesystem. The submitter's CLI writes shards to
            // ~/.infernet/training-runs/<run_id>/shards/shard-<i>.jsonl
            // and posts the URL referencing this same daemon's endpoint.
            // No third-party storage, no separate ports, no signup —
            // the daemon's already on a reachable port.
            //
            // Routes:
            //   GET /v1/training/shards/<run_id>/<shard_index>.jsonl
            //   PUT /v1/training/adapters/<run_id>/<shard_index>?token=<t>
            try {
                const handled = await handleTrainingHttp(req, res);
                if (handled) return;
            } catch (err) {
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end(`training http error: ${err?.message ?? err}\n`);
                return;
            }

            try {
                const censusHandled = await handleRpcCensus(req, res);
                if (censusHandled) return;
            } catch (err) {
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end(`rpc census error: ${err?.message ?? err}\n`);
                return;
            }

            try {
                const rpcHandled = await handleRpcInference(req, res);
                if (rpcHandled) return;
            } catch (err) {
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end(`rpc http error: ${err?.message ?? err}\n`);
                return;
            }

            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found\n');
        });
        await new Promise((resolve, reject) => {
            healthServer.once('error', reject);
            healthServer.listen(healthPort, '0.0.0.0', () => {
                healthServer.removeListener('error', reject);
                resolve();
            });
        });
        process.stdout.write(`/healthz listening on 0.0.0.0:${healthPort}\n`);
    } catch (err) {
        // Health server failure is non-fatal — daemon still does its
        // job, we just won't get container-level liveness probes.
        process.stderr.write(`/healthz failed to bind on :${healthPort}: ${err?.message ?? err}\n`);
        healthServer = null;
    }

    if (!p2pDisabled) {
        try {
            p2pServer = await startP2pServer();
            process.stdout.write(`P2P listening on ${formatEndpoint(advertisedAddress ?? '-', p2pPort)} (dual-stack)\n`);
        } catch (err) {
            const cause = err?.code === 'EADDRINUSE'
                ? ` (port ${p2pPort} is already in use — pick another with --p2p-port)`
                : err?.code === 'EACCES'
                    ? ` (permission denied — try a port above 1024)`
                    : '';
            process.stderr.write(`Failed to bind P2P listener on port ${p2pPort}${cause}: ${err?.message ?? err}\n`);
            process.stderr.write('If this is a firewall issue, run `infernet firewall` for per-distro commands.\n');
        }
    }

    // Ensure a valid bearer token exists. Refreshes autonomously using the
    // node keypair so the daemon never needs a manual `infernet login`.
    {
        const cfg = await loadConfig().catch(() => null);
        const expAt = cfg?.auth?.expiresAt ? new Date(cfg.auth.expiresAt) : null;
        const needsRefresh = !cfg?.auth?.bearerToken || !expAt || expAt - Date.now() < 30 * 86400 * 1000;
        if (needsRefresh) {
            nodeTokenLogin(cfg ?? config).catch((err) =>
                process.stderr.write(`[login] auto-refresh failed: ${err?.message ?? err}\n`)
            );
        }
    }

    await heartbeat();
    await pollJobs();
    await pollNodeCommands();

    if (once) {
        if (ipcServer) { try { ipcServer.close(); } catch {} }
        if (p2pServer) { try { p2pServer.close(); } catch {} }
        if (healthServer) { try { healthServer.close(); } catch {} }
        removeSocketFile();
        await removePidFile();
        return 0;
    }

    heartbeatTimer = setInterval(() => {
        heartbeat().catch((err) => process.stderr.write(`heartbeat threw: ${err?.message ?? err}\n`));
    }, heartbeatMs);
    pollTimer = setInterval(() => {
        pollJobs().catch((err) => process.stderr.write(`poll threw: ${err?.message ?? err}\n`));
    }, pollMs);
    // Commands poll less often than jobs — they're rare (model
    // install/remove from the dashboard) and ollama pull can take
    // minutes, so we don't want overlapping pulls of the same model.
    const commandPollMs = Math.max(pollMs * 2, 30_000);
    const commandTimer = setInterval(() => {
        pollNodeCommands().catch((err) =>
            process.stderr.write(`command poll threw: ${err?.message ?? err}\n`)
        );
    }, commandPollMs);
    if (typeof commandTimer.unref === 'function') commandTimer.unref();

    // Open-market training (IPIP-0030). Daemons that opted in via
    // `infernet config set engine.acceptTraining true` (or env var
    // INFERNET_ACCEPT_TRAINING=1) poll for available shards and run them
    // for pay. Every ~60s — training shards are rare + slow, so polling
    // hot wastes RPS.
    const acceptTraining = process.env.INFERNET_ACCEPT_TRAINING === '1'
        || config?.engine?.acceptTraining === true;
    if (acceptTraining) {
        process.stdout.write('[training] open-market shard claiming enabled\n');
        const trainingPollMs = 60_000;
        const trainingTimer = setInterval(() => {
            pollTrainingMarket().catch((err) =>
                process.stderr.write(`training poll threw: ${err?.message ?? err}\n`)
            );
        }, trainingPollMs);
        if (typeof trainingTimer.unref === 'function') trainingTimer.unref();
    }

    // Self-update: check npm registry every 5 minutes. If a newer version is
    // available, pull the installer, re-generate any missing keys + re-register
    // specs (idempotent), then re-exec so the new code is running immediately.
    let isUpgrading = false;
    const updateTimer = setInterval(async () => {
        if (shuttingDown || isUpgrading) return;
        // Never start an upgrade under a running job; the next check retries.
        if (stats.activeJobIds.size > 0) return;
        const latest = await fetchLatestVersion();
        if (!latest || !isNewerVersion(CURRENT_VERSION, latest)) return;
        isUpgrading = true;

        process.stdout.write(`[update] v${latest} available (running v${CURRENT_VERSION}) — upgrading\n`);
        const ok = await pullLatestBinary();
        if (!ok) {
            process.stderr.write('[update] installer failed — will retry next check\n');
            isUpgrading = false;
            return;
        }

        // Post-upgrade: run `infernet upgrade --skip-setup` is already done
        // (pullLatestBinary above). Now run setup --yes so keys are regenerated,
        // specs re-registered, and the daemon restarts cleanly via re-exec below.
        process.stdout.write('[update] re-initializing keys and specs\n');
        try {
            const { default: setup } = await import('./setup.js');
            const setupArgs = new Map([['yes', true], ['confirm', true], ['skip-pull', true], ['skip-daemon', true]]);
            await setup(setupArgs, { config, client, configPath });
        } catch (err) {
            process.stderr.write(`[update] post-upgrade setup: ${err?.message ?? err}\n`);
        }

        // Jobs that arrived while the installer ran get to finish: stop taking
        // new ones and wait. Restarting under them used to fail every one
        // ("daemon restarting for self-update", 23 jobs on 2026-09-30).
        stats.draining = true;
        const drainUntil = Date.now() + UPDATE_DRAIN_MS;
        while (stats.activeJobIds.size > 0 && Date.now() < drainUntil) {
            await new Promise((r) => setTimeout(r, 1000));
        }

        // Release whatever is still running after the drain window.
        for (const jobId of stats.activeJobIds) {
            try {
                await client.failJob(jobId, 'daemon restarting for self-update');
            } catch { /* best-effort */ }
        }
        stats.activeJobIds.clear();

        // Tear down servers BEFORE spawning the new process so the new daemon
        // can bind the same ports without EADDRINUSE races.
        shuttingDown = true;
        clearInterval(heartbeatTimer);
        clearInterval(pollTimer);
        clearInterval(commandTimer);
        clearInterval(updateTimer);
        if (ipcServer)    try { ipcServer.close();    } catch {}
        if (p2pServer)    try { p2pServer.close();    } catch {}
        if (healthServer) try { healthServer.close(); } catch {}
        try { await shutdownEngine(); } catch {}
        removeSocketFile();
        await removePidFile();

        // Small grace period so OS reclaims the ports before the new process binds.
        await new Promise((r) => setTimeout(r, 500));

        // Re-exec the daemon with the same args so the new code is live.
        process.stdout.write('[update] restarting daemon with new version\n');
        const logPath = getDaemonLogPath();
        const logFd = openSync(logPath, 'a');
        spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: process.env
        }).unref();

        process.exit(0);
    }, UPDATE_CHECK_MS);
    if (typeof updateTimer.unref === 'function') updateTimer.unref();

    await new Promise(() => {});
    return 0;
}

export { HELP };
