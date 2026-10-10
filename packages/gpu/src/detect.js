/**
 * GPU detection for Infernet Protocol.
 *
 * Returns a normalized array of GPU descriptors collected from whichever
 * vendor tooling is present on the host. Runs are best-effort: any vendor
 * whose detection tool is missing or fails is silently skipped.
 *
 * Normalized shape:
 *   {
 *     vendor:     'nvidia' | 'amd' | 'apple' | 'intel',
 *     index:      number,
 *     model:      string,
 *     vram_mb:    number | null,
 *     vram_used_mb: number | null,
 *     utilization: number | null,   // 0..100
 *     temperature_c: number | null,
 *     power_w:    number | null,
 *     driver:     string | null,
 *     cuda:       string | null,    // for NVIDIA only
 *     uuid:       string | null
 *   }
 *
 * The CLI / daemon calls `detectGpus()` and stores the result in the
 * `providers.specs.gpus` jsonb column, plus surfaces live utilization in
 * the daemon IPC `stats` snapshot.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

const EXEC_TIMEOUT_MS = 4000;

/**
 * Module-level diagnostics from the most recent `detectGpus()` call —
 * per-vendor "why we found nothing" reasons. Cleared on each detect
 * run. Read via `lastDetectionDiagnostics()` from the CLI to surface
 * actionable hints when no GPUs are detected.
 */
let lastDiagnostics = {};

export function lastDetectionDiagnostics() {
    return { ...lastDiagnostics };
}

async function tryExec(bin, args) {
    try {
        const { stdout } = await pExecFile(bin, args, { timeout: EXEC_TIMEOUT_MS });
        return { stdout, error: null };
    } catch (err) {
        // ENOENT = binary not on PATH. Other codes = it ran but failed
        // (driver issue, permission, timeout). Both are useful signals.
        const code = err?.code ?? null;
        const reason =
            code === 'ENOENT' ? 'not installed (binary missing)' :
            code === 'ETIMEDOUT' ? `timed out after ${EXEC_TIMEOUT_MS}ms` :
            err?.stderr ? String(err.stderr).trim().split('\n')[0].slice(0, 200) :
            err?.message ? String(err.message).slice(0, 200) :
            'unknown error';
        return { stdout: null, error: { code, reason } };
    }
}

// ---------------------------------------------------------------------------
// NVIDIA — nvidia-smi
// ---------------------------------------------------------------------------
async function detectNvidia() {
    const query = [
        'index', 'name', 'memory.total', 'memory.used', 'utilization.gpu',
        'temperature.gpu', 'power.draw', 'driver_version', 'uuid'
    ].join(',');
    const result = await tryExec('nvidia-smi', [
        `--query-gpu=${query}`,
        '--format=csv,noheader,nounits'
    ]);
    if (!result.stdout) {
        lastDiagnostics.nvidia = result.error
            ? `nvidia-smi: ${result.error.reason}`
            : 'nvidia-smi: empty output';
        return [];
    }
    const out = result.stdout;

    const cudaResult = await tryExec('nvidia-smi', ['--query', '--display=COMPUTE']);
    let cuda = null;
    if (cudaResult.stdout) {
        const m = cudaResult.stdout.match(/CUDA Version\s*:\s*([\d.]+)/i);
        if (m) cuda = m[1];
    }

    const gpus = [];
    for (const raw of out.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split(',').map((s) => s.trim());
        if (parts.length < 9) continue;
        const [
            index, name, memTotal, memUsed, util,
            temp, power, driver, uuid
        ] = parts;
        gpus.push({
            vendor: 'nvidia',
            index: Number.parseInt(index, 10),
            model: name,
            vram_mb: toNum(memTotal),
            vram_used_mb: toNum(memUsed),
            utilization: toNum(util),
            temperature_c: toNum(temp),
            power_w: toNum(power),
            driver: driver || null,
            cuda,
            uuid: uuid || null
        });
    }
    return gpus;
}

// ---------------------------------------------------------------------------
// AMD — rocm-smi
// ---------------------------------------------------------------------------
async function detectAmd() {
    const result = await tryExec('rocm-smi', ['--showproductname', '--showmeminfo', 'vram',
        '--showuse', '--showtemp', '--showpower', '--showdriverversion', '--json']);
    if (!result.stdout) {
        lastDiagnostics.amd = result.error
            ? `rocm-smi: ${result.error.reason}`
            : 'rocm-smi: empty output';
        return [];
    }
    let parsed;
    try { parsed = JSON.parse(result.stdout); }
    catch (err) {
        lastDiagnostics.amd = `rocm-smi: parse error (${err?.message ?? err})`;
        return [];
    }

    const gpus = [];
    let i = 0;
    for (const key of Object.keys(parsed)) {
        if (!key.startsWith('card')) continue;
        const card = parsed[key] ?? {};
        const vramTotal = parseRocmBytes(card['VRAM Total Memory (B)']);
        const vramUsed  = parseRocmBytes(card['VRAM Total Used Memory (B)']);
        gpus.push({
            vendor: 'amd',
            index: i,
            model: card['Card series'] || card['Card model'] || 'AMD GPU',
            vram_mb: vramTotal != null ? Math.round(vramTotal / (1024 * 1024)) : null,
            vram_used_mb: vramUsed != null ? Math.round(vramUsed / (1024 * 1024)) : null,
            utilization: toNum(card['GPU use (%)']),
            temperature_c: toNum(card['Temperature (Sensor edge) (C)']),
            power_w: toNum(card['Average Graphics Package Power (W)']),
            driver: card['Driver version'] ?? null,
            cuda: null,
            uuid: card['Unique ID'] ?? null
        });
        i += 1;
    }
    return gpus;
}

function parseRocmBytes(v) {
    if (v == null) return null;
    const n = Number.parseInt(String(v).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Apple Silicon / macOS — system_profiler
// ---------------------------------------------------------------------------
async function detectApple() {
    if (process.platform !== 'darwin') {
        lastDiagnostics.apple = `skipped (platform=${process.platform}, system_profiler is darwin-only)`;
        return [];
    }
    const result = await tryExec('system_profiler', ['SPDisplaysDataType', '-json']);
    if (!result.stdout) {
        lastDiagnostics.apple = result.error
            ? `system_profiler: ${result.error.reason}`
            : 'system_profiler: empty output';
        return [];
    }
    let parsed;
    try { parsed = JSON.parse(result.stdout); }
    catch (err) {
        lastDiagnostics.apple = `system_profiler: parse error (${err?.message ?? err})`;
        return [];
    }
    const items = parsed.SPDisplaysDataType ?? [];
    const gpus = [];
    items.forEach((item, i) => {
        // Apple Silicon has unified memory — report total system RAM as a
        // proxy when the card-level VRAM isn't reported.
        const vramStr = item.spdisplays_vram ?? item._spdisplays_vram ?? null;
        gpus.push({
            vendor: 'apple',
            index: i,
            model: item.sppci_model ?? item._name ?? 'Apple GPU',
            vram_mb: parseMacVram(vramStr),
            vram_used_mb: null,
            utilization: null,
            temperature_c: null,
            power_w: null,
            driver: null,
            cuda: null,
            uuid: null
        });
    });
    return gpus;
}

function parseMacVram(s) {
    if (!s) return null;
    const m = String(s).match(/([\d.]+)\s*(GB|MB)/i);
    if (!m) return null;
    const n = Number.parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    return m[2].toUpperCase() === 'GB' ? Math.round(n * 1024) : Math.round(n);
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------
/**
 * Last-resort PCI fallback for Linux. If nvidia-smi / rocm-smi /
 * system_profiler all came back empty but a discrete GPU is physically
 * installed, `lspci` will still see it. We can't query VRAM / utilization
 * via lspci, so the resulting descriptor is bare — but it's strictly
 * better than reporting "CPU-only" on a box with a 4090 in it.
 *
 * Triggers ONLY when no other vendor returned anything, and only on Linux.
 */
async function detectLspciFallback() {
    if (process.platform !== 'linux') return [];
    const result = await tryExec('lspci', ['-mm', '-d', '::0300']); // class 0x0300 = VGA
    if (!result.stdout) {
        // Try the broader `-nn` form so `3d controllers` (class 0302) also surface.
        const fb = await tryExec('lspci', ['-nn']);
        if (!fb.stdout) {
            lastDiagnostics.lspci = result.error
                ? `lspci: ${result.error.reason}`
                : 'lspci: no VGA-class devices reported';
            return [];
        }
        const lines = fb.stdout.split('\n').filter((l) => /VGA|3D controller|Display controller/i.test(l));
        if (lines.length === 0) {
            lastDiagnostics.lspci = 'lspci ran but no VGA/3D/Display devices found';
            return [];
        }
        return parseLspciLines(lines);
    }
    const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
        lastDiagnostics.lspci = 'lspci ran but reported no VGA devices';
        return [];
    }
    return parseLspciLines(lines);
}

// Display adapters that are never an inference GPU: hypervisor-emulated VGA
// (QEMU std-vga 1234, Cirrus 1013, VMware 15ad, VirtualBox 80ee, virtio 1af4,
// QXL 1b36, Hyper-V 1414) and server BMC framebuffers (ASPEED 1a03, Matrox
// G200 102b). Matched by PCI vendor id (-nn) or vendor name (-mm).
const NON_COMPUTE_VGA_IDS = /\[(1234|1013|15ad|80ee|1af4|1b36|1414|1a03|102b):[0-9a-f]{4}\]/i;
const NON_COMPUTE_VGA_NAMES = /\b(vendor 1234|qemu|bochs|cirrus logic|vmware|virtualbox|innotek|virtio|qxl|hyper-v|aspeed|matrox)\b/i;

export function isNonComputeDisplay(line) {
    return NON_COMPUTE_VGA_IDS.test(line) || NON_COMPUTE_VGA_NAMES.test(line);
}

export function parseLspciLines(lines) {
    const real = lines.filter((l) => !isNonComputeDisplay(l));
    if (real.length === 0) {
        lastDiagnostics.lspci = 'lspci found only virtual/BMC display adapters (no compute GPU)';
        return [];
    }
    return real.map((line, i) => parseLspciLine(line, i));
}

export function parseLspciLine(line, index) {
    // -mm output: BDF "Vendor" "Device" "Subsys" ...
    // -nn output: BDF Class: Vendor Device [vendor:dev]
    let vendor = null;
    let model = line.trim();
    const lower = line.toLowerCase();
    if (lower.includes('nvidia')) vendor = 'nvidia';
    else if (lower.includes('amd') || lower.includes('ati ')) vendor = 'amd';
    else if (lower.includes('intel')) vendor = 'intel';
    // -mm format: the quoted fields are class, vendor, device — the model
    // is vendor + device, not the class name.
    const q = [...line.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (q.length >= 3) model = `${q[1]} ${q[2]}`.trim();
    return {
        vendor: vendor ?? 'unknown',
        index,
        model: model.slice(0, 96),
        vram_mb: null,
        vram_used_mb: null,
        utilization: null,
        temperature_c: null,
        power_w: null,
        driver: null,
        cuda: null,
        uuid: null,
        source: 'lspci' // marker so callers can surface "install vendor tooling for full info"
    };
}

/**
 * Collect GPU descriptors from all detected vendors. Always returns an
 * array (empty if no GPU is physically present). Each call resets and
 * populates module-level diagnostics — read via lastDetectionDiagnostics()
 * to surface "we tried nvidia-smi but it errored with X" hints.
 */
export async function detectGpus() {
    lastDiagnostics = {};
    const [nvidia, amd, apple] = await Promise.all([
        detectNvidia(), detectAmd(), detectApple()
    ]);
    const found = [...nvidia, ...amd, ...apple];
    if (found.length > 0) return found;
    // Vendor tooling reported nothing — last-resort lspci fallback so a
    // box with a discrete GPU but missing drivers/tooling at least
    // surfaces the hardware presence.
    return detectLspciFallback();
}

/**
 * Summarize detected GPUs into one line per card.
 */
export function formatGpuLine(gpu) {
    const vram = gpu.vram_mb ? `${(gpu.vram_mb / 1024).toFixed(1)} GB VRAM` : 'VRAM unknown';
    const extras = [];
    if (gpu.utilization != null) extras.push(`${gpu.utilization}% util`);
    if (gpu.temperature_c != null) extras.push(`${gpu.temperature_c}°C`);
    if (gpu.power_w != null) extras.push(`${gpu.power_w}W`);
    const suffix = extras.length ? ` (${extras.join(', ')})` : '';
    const cuda = gpu.cuda ? ` cuda=${gpu.cuda}` : '';
    return `[${gpu.vendor}:${gpu.index}] ${gpu.model} — ${vram}${cuda}${suffix}`;
}

function toNum(v) {
    if (v == null) return null;
    const n = Number.parseFloat(String(v).trim().replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
}
