/**
 * Aggregator duty, phase 1: independent provider verification.
 *
 * Every round an aggregator reads the public peer list (/api/peers), dials each
 * provider's advertised P2P address, sends `{"cmd":"info"}` and times the reply.
 * The signed report (POST /api/v1/node/aggregator/probes) lets /status say
 * "reachable, verified by N aggregators" instead of trusting a node's own
 * heartbeat. Later phases add coordination of multi-node jobs (IPIP-0028/0033).
 */

import net from 'node:net';

export const PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_CONCURRENCY = 8;
const MAX_PEERS = 500;

/** `/ip4/1.2.3.4/tcp/46337` or `/dns4/host/tcp/n` -> { host, port }, else null. */
export function parseMultiaddr(addr) {
    const m = /^\/(ip4|ip6|dns4|dns6|dns)\/([^/]+)\/tcp\/(\d{1,5})$/.exec(String(addr ?? ''));
    if (!m) return null;
    const port = Number(m[3]);
    if (port < 1 || port > 65535) return null;
    return { host: m[2], port };
}

/**
 * Dial one peer and ask for its identity.
 * @returns {Promise<{ reachable: boolean, rtt_ms: number|null, node_id: string|null, error: string|null }>}
 */
export function probePeer({ host, port }, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let settled = false;
        let buf = '';
        const sock = net.connect({ host, port });
        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            resolve(result);
        };
        const timer = setTimeout(
            () => done({ reachable: false, rtt_ms: null, node_id: null, error: 'timeout' }),
            timeoutMs
        );
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(JSON.stringify({ cmd: 'info' }) + '\n'));
        sock.on('data', (chunk) => {
            buf += chunk;
            const nl = buf.indexOf('\n');
            if (nl < 0) {
                if (buf.length > 8192) done({ reachable: false, rtt_ms: null, node_id: null, error: 'bad-reply' });
                return;
            }
            let msg = null;
            try { msg = JSON.parse(buf.slice(0, nl)); } catch { /* handled below */ }
            if (msg?.ok && msg.data) {
                done({ reachable: true, rtt_ms: Date.now() - t0, node_id: String(msg.data.node_id ?? '') || null, error: null });
            } else {
                done({ reachable: false, rtt_ms: null, node_id: null, error: 'bad-reply' });
            }
        });
        sock.on('error', (err) => done({ reachable: false, rtt_ms: null, node_id: null, error: err?.code ?? 'error' }));
        sock.on('close', () => done({ reachable: false, rtt_ms: null, node_id: null, error: 'closed' }));
    });
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/**
 * One probe round: fetch peers, probe them, report. Never throws.
 * @returns {Promise<{ probed: number, reachable: number, error?: string }>}
 */
export async function runProbeRound({ client, controlPlaneUrl, fetchImpl = fetch, probe = probePeer }) {
    try {
        const res = await fetchImpl(`${controlPlaneUrl.replace(/\/+$/, '')}/api/peers`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) return { probed: 0, reachable: 0, error: `peers HTTP ${res.status}` };
        const peers = ((await res.json())?.data ?? [])
            .filter((p) => p?.pubkey && parseMultiaddr(p.multiaddr))
            .slice(0, MAX_PEERS);
        const results = await mapLimit(peers, PROBE_CONCURRENCY, async (p) => ({
            pubkey: p.pubkey,
            ...(await probe(parseMultiaddr(p.multiaddr)))
        }));
        if (results.length > 0) await client.signedFetch('/api/v1/node/aggregator/probes', { probes: results });
        return { probed: results.length, reachable: results.filter((r) => r.reachable).length };
    } catch (err) {
        return { probed: 0, reachable: 0, error: err?.message ?? String(err) };
    }
}
