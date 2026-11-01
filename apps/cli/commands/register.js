/**
 * `infernet register`
 *
 * Announces this node to the control plane via a Nostr-signed POST to
 * /api/v1/node/register. The server verifies ownership of the pubkey and
 * upserts a row in providers / aggregators / clients keyed on node_id.
 *
 * Only coarse capability data is sent — vendor + VRAM tier per GPU. No
 * hostname, platform, CPU model, or RAM total leaves the node.
 */

import { saveConfig, loadConfig } from '../lib/config.js';
import { resolveP2pPort, detectLocalAddress } from '../lib/network.js';
import { detectGpus, detectInterconnects, detectCpus, detectHost } from '@infernetprotocol/gpu';

/**
 * Probe Ollama for the actual list of models pulled locally, with
 * sizes. Empty array on any failure — we still want to register the
 * node even if the engine isn't up at register time.
 */
async function detectOllamaModels(host) {
    if (!host) return [];
    try {
        const res = await fetch(new URL('/api/tags', host), { signal: AbortSignal.timeout?.(2000) });
        if (!res.ok) return [];
        const json = await res.json();
        const models = Array.isArray(json?.models) ? json.models : [];
        return models
            .map((m) => ({
                name: m.name ?? m.model,
                size_bytes: typeof m.size === 'number' ? m.size : null
            }))
            .filter((m) => typeof m.name === 'string' && m.name);
    } catch {
        return [];
    }
}

/**
 * Filter out models that physically can't fit on this node. A node
 * advertising a model it can't actually serve is worse than not
 * advertising at all — clients route there, the inference 500s mid-
 * stream, the network's reputation rots.
 *
 * Heuristic (intentionally conservative — better to under-advertise):
 *   - GPU box: model fits if size < 0.85 × total VRAM across all GPUs.
 *     0.15 headroom covers KV cache + quantization overhead.
 *   - CPU-only box: model fits if size < 0.6 × total RAM. Lower because
 *     the OS, Ollama itself, and other processes need RAM too, and CPU
 *     inference's working set is roughly the model size + activations.
 *
 * Models with no reported size pass through (we can't verify, so we
 * trust the operator + Ollama's own load-time check).
 */
export function filterFittingModels(models, { totalVramBytes, totalRamBytes }) {
    const hasGpu = Number.isFinite(totalVramBytes) && totalVramBytes > 0;
    const ceiling = hasGpu
        ? totalVramBytes * 0.85
        : (Number.isFinite(totalRamBytes) ? totalRamBytes * 0.6 : Number.POSITIVE_INFINITY);

    const fitting = [];
    const rejected = [];
    for (const m of models) {
        if (!Number.isFinite(m.size_bytes)) {
            // Unknown size — pass through. Ollama will reject at load time
            // if it really can't fit; our heuristic is just a pre-filter.
            fitting.push(m.name);
            continue;
        }
        if (m.size_bytes <= ceiling) {
            fitting.push(m.name);
        } else {
            rejected.push({ name: m.name, size_gb: +(m.size_bytes / 1024 ** 3).toFixed(2) });
        }
    }
    return { fitting, rejected, ceiling_gb: +(ceiling / 1024 ** 3).toFixed(2), mode: hasGpu ? 'gpu' : 'cpu' };
}

const HELP = `infernet register — announce this node to the control plane

Usage:
  infernet register [flags]

Flags:
  --address <host>    Public address to advertise
  --port <n>          Public port to advertise
  --gpu-model <name>  GPU model (providers only)
  --price <n>         Price offer (providers only)
  --no-advertise      Don't send address / port
  --help              Show this help
`;

function vramTier(vramMb) {
    if (!Number.isFinite(vramMb) || vramMb <= 0) return 'unknown';
    if (vramMb < 8 * 1024) return '<8gb';
    if (vramMb < 16 * 1024) return '8-16gb';
    if (vramMb < 24 * 1024) return '16-24gb';
    if (vramMb < 48 * 1024) return '24-48gb';
    return '>=48gb';
}

/**
 * Reduce interconnect detection to a coarse, leak-free shape:
 *   - device names / board_ids stripped
 *   - just the capability flags clients need for matchmaking
 */
function summarizeInterconnects(ic) {
    const nvlink = ic?.nvlink ?? { available: false, topology: 'none', links: [] };
    const xgmi = ic?.xgmi ?? { available: false, topology: 'none', links: [] };
    const ib = ic?.infiniband ?? { available: false, devices: [] };
    const efa = ic?.efa ?? { available: false, devices: [] };
    const activePorts = ib.devices.filter((d) => d.state === 'active');
    return {
        nvlink: {
            available: !!nvlink.available,
            topology: nvlink.topology ?? 'none',
            link_count: Array.isArray(nvlink.links) ? nvlink.links.length : 0
        },
        xgmi: {
            available: !!xgmi.available,
            topology: xgmi.topology ?? 'none',
            link_count: Array.isArray(xgmi.links) ? xgmi.links.length : 0
        },
        infiniband: {
            available: !!ib.available,
            active_port_count: activePorts.length
        },
        efa: {
            available: !!efa.available,
            adapter_count: Array.isArray(efa.devices) ? efa.devices.length : 0
        },
        rdma_capable: !!ic?.rdma_capable
    };
}

/**
 * Coarse CPU summary: vendor, arch, total core count, and group count.
 * Deliberately omits the exact CPU model string + clock speed (those
 * fingerprint the SKU). Vendor + arch + core count is enough for
 * matchmaking and dashboard display.
 */
function summarizeCpu() {
    const host = detectHost();
    const cpus = detectCpus();
    const first = cpus[0] ?? {};
    return {
        vendor: first.vendor ?? null,        // intel | amd | apple | aws | ampere | null
        arch: host.arch,                     // x64 | arm64 | ...
        cores: host.cpu_count,               // logical cores
        groups: cpus.length,                 // 1 for homogeneous boxes; >1 for P+E etc
        ram_gb: Math.round(host.total_ram_mb / 1024)
    };
}

export async function gatherCoarseSpecs() {
    const [gpus, interconnects, config] = await Promise.all([
        detectGpus(),
        detectInterconnects(),
        loadConfig().catch(() => ({}))
    ]);

    // Models: every model Ollama has pulled, FILTERED to those that
    // actually fit this box's RAM/VRAM. Advertising a model we can't
    // serve is worse than not advertising it — clients route there,
    // inference 500s mid-stream, network reputation tanks.
    const configuredModel = config?.engine?.model ?? null;
    const ollamaHost = config?.engine?.ollamaHost ?? null;
    const pulledModels = ollamaHost ? await detectOllamaModels(ollamaHost) : [];

    // Capacity inputs in bytes — sum VRAM across all GPUs (multi-GPU
    // boxes can fit a model larger than any single card via tensor
    // parallelism, which Ollama handles automatically when it sees both).
    const totalVramBytes = gpus.reduce(
        (a, g) => a + (Number.isFinite(g.vram_mb) ? g.vram_mb * 1024 * 1024 : 0),
        0
    );
    const host = detectHost();
    const totalRamBytes = host.total_ram_mb * 1024 * 1024;

    const { fitting, rejected } = filterFittingModels(pulledModels, {
        totalVramBytes,
        totalRamBytes
    });

    if (rejected.length > 0) {
        const sizes = rejected.map((r) => `${r.name} (${r.size_gb} GB)`).join(', ');
        process.stderr.write(
            `\nNote: ${rejected.length} model(s) may be tight on memory: ${sizes}\n` +
            `      Advertising anyway — Ollama will handle it at load time.\n` +
            `      Remove with \`infernet model remove <name>\` if you want to drop it.\n\n`
        );
    }

    // Advertise all pulled models — operator explicitly installed them so we
    // trust they know their hardware. The fit check is informational only.
    // Also fold in any model vLLM is currently serving (:8000/v1/models),
    // advertised under its `hf:` pull name via --served-model-name, so vLLM
    // models show up in /chat alongside Ollama ones.
    let vllmModels = [];
    try {
        const { detectVllmModels } = await import('../lib/vllm.js');
        vllmModels = await detectVllmModels();
    } catch { /* vLLM not installed / not serving — Ollama-only */ }
    const served_models = [...new Set([...pulledModels.map((m) => m.name), ...vllmModels])];

    return {
        e2e_capable: true,
        e2e_version: 'nip44-v2',
        cpu: summarizeCpu(),
        gpu_count: gpus.length,
        gpus: gpus.map((g) => ({
            vendor: (g.vendor ?? 'unknown').toLowerCase(),
            vram_tier: vramTier(g.vram_mb),
            model: typeof g.model === 'string' ? g.model.slice(0, 64) : null
        })),
        interconnects: summarizeInterconnects(interconnects),
        served_models
    };
}

export default async function register(args, ctx) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }

    const { config, client, configPath } = ctx;
    const node = config.node ?? {};
    if (!node.role || !node.nodeId) {
        process.stderr.write('Config is missing node.role or node.nodeId. Run `infernet init` first.\n');
        return 1;
    }

    const noAdvertise = args.has('no-advertise');
    const addressFlag = args.get('address');
    const portFlag = args.get('port') ?? args.get('p2p-port');
    const address = noAdvertise ? undefined : (addressFlag ?? node.address ?? await detectLocalAddress());
    const portRaw = portFlag ?? node.port;
    const port = noAdvertise ? undefined
        : (portRaw ? Number.parseInt(portRaw, 10) : resolveP2pPort({ node }));

    const payload = {
        node_id: node.nodeId,
        name: node.name ?? node.nodeId
    };
    if (address) payload.address = address;
    if (Number.isFinite(port) && port > 0) payload.port = port;

    if (node.role === 'provider') {
        const specs = await gatherCoarseSpecs();
        payload.specs = specs;
        const gpuModel = args.get('gpu-model') ?? specs.gpus?.[0]?.model;
        if (gpuModel) payload.gpu_model = gpuModel;
        const price = args.get('price');
        if (price !== undefined) {
            const n = Number.parseFloat(price);
            if (Number.isFinite(n)) payload.price = n;
        }
    }

    // Display: lead with the human-readable name when one is configured;
    // fall back to the machine node_id otherwise. Operators recognize
    // their own user@host name; nobody recognizes "provider-0f44326c".
    const displayName = node.name && node.name !== node.nodeId ? node.name : node.nodeId;
    process.stdout.write(`Registering ${node.role} "${displayName}" (node_id=${node.nodeId})...\n`);

    let row;
    try {
        row = await client.register(payload);
    } catch (err) {
        process.stderr.write(`Register failed: ${err?.message ?? err}\n`);
        return 1;
    }

    // The register response can be terse on older deployments
    // (sometimes just { node_id }, no id). Fetch the canonical row
    // via the signed `me` endpoint so we always have the server's
    // truth, regardless of the deployed register handler's shape.
    let canonical = row;
    let canonicalId = row?.id ?? null;
    try {
        const me = await client.me();
        if (me && typeof me === "object") {
            canonical = me;
            canonicalId = me.id ?? canonicalId;
        }
    } catch {
        // Non-fatal: we'll fall back to whatever register returned.
    }

    const nextConfig = {
        ...config,
        node: {
            ...node,
            id: canonicalId ?? node.id ?? null,
            address: noAdvertise ? null : (address ?? node.address ?? null),
            port: noAdvertise ? null : (Number.isFinite(port) ? port : node.port ?? null)
        }
    };
    await saveConfig(nextConfig);

    const displayId = canonicalId ?? "(server did not return one)";
    const displayNodeId = canonical?.node_id ?? row?.node_id ?? node.nodeId;
    process.stdout.write(`Registered. id=${displayId} node_id=${displayNodeId}\n`);
    if (canonicalId) {
        process.stdout.write(`Config updated with assigned uuid at ${configPath}\n`);
    } else {
        process.stdout.write(`Note: control plane returned no id — likely an older deployment.\n`);
        process.stdout.write(`      registration succeeded; id will populate after first heartbeat.\n`);
    }
    return 0;
}

export { HELP, vramTier, summarizeCpu, summarizeInterconnects };
