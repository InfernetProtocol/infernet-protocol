/**
 * Node-side client for the Infernet control-plane API.
 *
 * Every call is signed with the node's Nostr privkey (Schnorr / BIP-340)
 * and carries an X-Infernet-Auth envelope the server verifies. The node
 * never learns any DB credential — proof of ownership is the signature.
 */

import { signRequest, AUTH_HEADER } from '@infernetprotocol/auth';

function trimTrailingSlash(url) {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * @typedef {Object} ClientConfig
 * @property {string} url          - control-plane base URL
 * @property {string} publicKey    - 64-char hex Nostr pubkey
 * @property {string} privateKey   - 64-char hex Nostr privkey
 * @property {string} [role]       - provider | aggregator | client
 * @property {number} [timeoutMs]  - per-request timeout (default 15000)
 */

export function createNodeClient({ url, publicKey, privateKey, role, timeoutMs = 15000 }) {
    if (!url) throw new Error('node client: url is required');
    if (!publicKey || !privateKey) throw new Error('node client: publicKey + privateKey are required');
    const base = trimTrailingSlash(url);

    async function signedFetch(path, body) {
        const bodyText = body === undefined ? '' : JSON.stringify(body);
        const { header } = signRequest({
            method: 'POST',
            path,
            body: bodyText,
            publicKey,
            privateKey
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetch(base + path, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    [AUTH_HEADER]: header
                },
                body: bodyText,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }

        let payload = null;
        const text = await res.text();
        if (text) {
            try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
        }

        if (!res.ok) {
            const msg = payload?.error ?? `HTTP ${res.status}`;
            const err = new Error(`${path} failed: ${msg}`);
            err.status = res.status;
            err.body = payload;
            throw err;
        }
        return payload?.data ?? null;
    }

    return {
        base,
        publicKey,
        role,
        signedFetch,

        register(input) {
            return signedFetch('/api/v1/node/register', { role, ...input });
        },

        heartbeat(input = {}) {
            return signedFetch('/api/v1/node/heartbeat', { role, ...input });
        },

        pollJobs(input = {}) {
            return signedFetch('/api/v1/node/jobs/poll', input);
        },

        completeJob(jobId, input = {}) {
            return signedFetch(`/api/v1/node/jobs/${encodeURIComponent(jobId)}/complete`, input);
        },

        failJob(jobId, error) {
            return signedFetch(`/api/v1/node/jobs/${encodeURIComponent(jobId)}/complete`, {
                status: 'failed',
                error: typeof error === 'string' ? error : String(error?.message ?? error)
            });
        },

        postJobEvents(jobId, events) {
            return signedFetch(`/api/v1/node/jobs/${encodeURIComponent(jobId)}/events`, { events });
        },

        remove() {
            return signedFetch('/api/v1/node/remove', { role });
        },

        me() {
            return signedFetch('/api/v1/node/me', { role });
        },

        earnings(recent = 20) {
            return signedFetch('/api/v1/node/earnings', { recent });
        },

        requestPayout(amountUsd = null) {
            return signedFetch('/api/v1/node/payouts/request', amountUsd == null ? {} : { amount_usd: amountUsd });
        },

        listPayments(limit = 20) {
            return signedFetch('/api/v1/node/payments/list', { role, limit });
        },

        pollCommands(limit = 5) {
            return signedFetch('/api/v1/node/commands/poll', { limit });
        },

        completeCommand(commandId, { status, result, error: errorMessage } = {}) {
            return signedFetch(
                `/api/v1/node/commands/${encodeURIComponent(commandId)}/complete`,
                { status, result, error: errorMessage }
            );
        },

        updateCommandProgress(commandId, progress) {
            return signedFetch(
                `/api/v1/node/commands/${encodeURIComponent(commandId)}/progress`,
                { progress }
            );
        },

        // ---- Open-market training (IPIP-0030) ----

        listAvailableTrainingShards(limit = 5) {
            return signedFetch('/api/v1/training/shards/available', { limit });
        },

        claimTrainingShard(shardId) {
            return signedFetch(
                `/api/v1/training/shards/${encodeURIComponent(shardId)}/claim`,
                {}
            );
        },

        reportTrainingShard(shardId, payload) {
            return signedFetch(
                `/api/v1/training/shards/${encodeURIComponent(shardId)}/report`,
                payload
            );
        },

        listPayouts() {
            return signedFetch('/api/v1/node/payouts/list', {});
        },

        setPayout({ coin, network, address }) {
            return signedFetch('/api/v1/node/payouts/set', { coin, network, address });
        }
    };
}

export function createNodeClientFromConfig(config) {
    const node = config?.node ?? {};
    const url = config?.controlPlane?.url ?? config?.supabase?.url;
    if (!url) {
        throw new Error('config.controlPlane.url is not set; run `infernet login` to set the control-plane URL');
    }
    if (!node.publicKey || !node.privateKey) {
        throw new Error('config.node is missing Nostr keypair; run `infernet init`');
    }
    return createNodeClient({
        url,
        publicKey: node.publicKey,
        privateKey: node.privateKey,
        role: node.role
    });
}
