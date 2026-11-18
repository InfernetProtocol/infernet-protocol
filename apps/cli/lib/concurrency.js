/**
 * How many jobs a node runs at once (Anthony, 2026-11-18: "a node should be
 * able to handle parallel jobs if capacity exists, make that the default").
 *
 * Until 0.1.96 every node ran one job at a time unless the operator set
 * INFERNET_MAX_CONCURRENT_JOBS, and a second request queued behind the first.
 * Now the default follows capacity:
 *
 *   - CPU-only nodes: 1. CPU Ollama shares the same cores between requests,
 *     so two at once each run at half speed and both finish later.
 *   - GPU nodes: the runtime's parallel slots. When Ollama's
 *     OLLAMA_NUM_PARALLEL is known (set on ollama.service, by install.sh or
 *     the operator, or in this process's environment) that is the number;
 *     otherwise it is sized from total VRAM (slotsForVram), the same table
 *     install.sh uses to set OLLAMA_NUM_PARALLEL.
 *
 * Operator override, in order: INFERNET_MAX_CONCURRENT_JOBS, then
 * `engine.max_concurrent_jobs` in the node config.
 *
 * The heartbeat advertises the result as specs.load.concurrency_cap, and the
 * control plane routes a second job to a node only while it has a free slot
 * (apps/web/lib/routing/smart-pick.js).
 */

import { execFile } from 'node:child_process';

/** Max slots we size from VRAM alone. */
export const MAX_AUTO_SLOTS = 4;

/**
 * Parallel slots for a GPU with `totalVramGb` of memory. Each Ollama slot
 * gets its own KV cache for the full context (32K, q8_0 with flash
 * attention). The house 9B takes 6.2 GB with one slot, so a 12 GB card has
 * room for a second; an 8 GB card does not.
 *   no GPU or < 10 GB -> 1, 10-20 GB -> 2, 20-40 GB -> 3, 40 GB+ -> 4.
 * Keep in sync with ollama_parallel_slots in install.sh.
 */
export function slotsForVram(totalVramGb) {
    const v = Number(totalVramGb);
    if (!Number.isFinite(v) || v < 10) return 1;
    if (v < 20) return 2;
    if (v < 40) return 3;
    return MAX_AUTO_SLOTS;
}

function positiveInt(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** OLLAMA_NUM_PARALLEL out of `systemctl show -p Environment --value` output. */
export function parseOllamaNumParallel(environment) {
    if (typeof environment !== 'string') return null;
    const m = environment.match(/(?:^|\s|")OLLAMA_NUM_PARALLEL=(\d+)/);
    return m ? positiveInt(m[1]) : null;
}

/**
 * The OLLAMA_NUM_PARALLEL the local Ollama runs with, or null when unknown.
 * Reads ollama.service (no root needed), then this process's environment
 * (the `ollama serve` fallback that `infernet setup` starts inherits it).
 */
export async function ollamaNumParallel({ env = process.env, run = systemctlEnvironment } = {}) {
    const fromUnit = parseOllamaNumParallel(await run().catch(() => null));
    if (fromUnit) return fromUnit;
    return positiveInt(env.OLLAMA_NUM_PARALLEL);
}

function systemctlEnvironment() {
    if (process.platform !== 'linux') return Promise.resolve(null);
    return new Promise((resolve) => {
        execFile('systemctl', ['show', 'ollama.service', '-p', 'Environment', '--value'], { timeout: 3000 }, (err, stdout) => {
            resolve(err ? null : String(stdout));
        });
    });
}

/**
 * Pure: decide the daemon's concurrency. Returns { value, source }.
 *   env             process env (INFERNET_MAX_CONCURRENT_JOBS)
 *   config          node config (engine.max_concurrent_jobs)
 *   totalVramGb     summed GPU memory; 0/null on CPU-only nodes
 *   runtimeSlots    the runtime's parallel slots when known (OLLAMA_NUM_PARALLEL)
 */
export function resolveMaxConcurrentJobs({ env = process.env, config = {}, totalVramGb = null, runtimeSlots = null } = {}) {
    const fromEnv = positiveInt(env.INFERNET_MAX_CONCURRENT_JOBS);
    if (fromEnv) return { value: fromEnv, source: 'env INFERNET_MAX_CONCURRENT_JOBS' };
    const fromConfig = positiveInt(config?.engine?.max_concurrent_jobs);
    if (fromConfig) return { value: fromConfig, source: 'config engine.max_concurrent_jobs' };
    const vram = Number(totalVramGb);
    if (!Number.isFinite(vram) || vram <= 0) return { value: 1, source: 'cpu-only node' };
    const slots = positiveInt(runtimeSlots);
    if (slots) return { value: slots, source: 'OLLAMA_NUM_PARALLEL' };
    return { value: slotsForVram(vram), source: `${vram.toFixed(0)} GB VRAM` };
}

/** Summed VRAM (GB) from @infernetprotocol/gpu detectGpus() output. */
export function totalVramGbOf(gpus) {
    let total = 0;
    for (const g of Array.isArray(gpus) ? gpus : []) {
        if (Number.isFinite(g?.vram_mb)) total += g.vram_mb / 1024;
    }
    return total;
}
