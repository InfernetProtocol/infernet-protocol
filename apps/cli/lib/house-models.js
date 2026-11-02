/**
 * House models: models Profullstack publishes that every provider node pulls
 * and serves by default (Anthony, 2026-11-02: "our models always deploy to all
 * nodes, everyone's, not just ours").
 *
 * The list is a static JSON manifest in this repo (apps/web/public/
 * house-models.json), served at https://infernetprotocol.com/house-models.json.
 * Adding a model is a PR to that file. The daemon fetches it on start and every
 * few hours, pulls each listed model that fits this machine into Ollama (one at
 * a time, never while a job is running), verifies the pulled model's digest and
 * size against the manifest, and removes house models that leave the manifest.
 * Pulled models show up in served_models like any other Ollama model.
 *
 * Safety rules, because this downloads onto other people's machines:
 *   - The manifest is only fetched over HTTPS from our own domains.
 *   - A model the operator pulled themselves is never removed: only models the
 *     daemon pulled (recorded in house-models-state.json) are ever deleted.
 *   - A pull needs min_ram_gb of RAM and leaves at least a disk reserve free
 *     (10% of the disk, at least 10 GB, at most 50 GB), and house models as a
 *     whole stay under the operator's disk cap if one is set.
 *   - Opt out of everything with `--no-house-models`, `infernet house-models
 *     off` or INFERNET_HOUSE_MODELS=0; opt out of uncensored ones only with
 *     `--no-uncensored-models`, `infernet house-models uncensored off` or
 *     INFERNET_UNCENSORED_MODELS=0. Opting out removes what the daemon pulled.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getConfigDir } from './config.js';

export const DEFAULT_MANIFEST_URL = 'https://infernetprotocol.com/house-models.json';
export const ALLOWED_MANIFEST_HOSTS = ['infernetprotocol.com', 'www.infernetprotocol.com', 'c0mpute.com', 'www.c0mpute.com'];
export const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FIRST_SYNC_DELAY_MS = 2 * 60 * 1000;
/** A model that failed to pull or verify is not retried for this long. */
export const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const DISK_RESERVE_MIN_BYTES = 10 * 1024 ** 3;
export const DISK_RESERVE_FRACTION = 0.10;
/** 10% of a 1 TB disk is 100 GB; past this, 10% stops meaning "nearly full". */
export const DISK_RESERVE_MAX_BYTES = 50 * 1024 ** 3;

const GB = 1024 ** 3;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/;
const DIGEST_RE = /^(sha256:)?[a-f0-9]{64}$/;

const isOff = (v) => typeof v === 'string' && ['0', 'false', 'off', 'no'].includes(v.trim().toLowerCase());
const isOn = (v) => typeof v === 'string' && ['1', 'true', 'on', 'yes'].includes(v.trim().toLowerCase());

/**
 * Ollama lists a model without a tag as `<name>:latest`. Normalize so a
 * manifest source like `hf.co/org/repo` matches the tags entry.
 */
export function normalizeOllamaName(name) {
    if (typeof name !== 'string') return '';
    const n = name.trim();
    const last = n.split('/').pop() ?? '';
    return last.includes(':') ? n : `${n}:latest`;
}

function stripDigest(d) {
    return typeof d === 'string' ? d.replace(/^sha256:/, '').toLowerCase() : null;
}

/**
 * Validate a manifest document. Bad entries are dropped individually (and
 * reported in `rejected`) so one typo cannot stop every other model.
 */
export function parseManifest(doc) {
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.models)) {
        throw new Error('house-models manifest: expected an object with a "models" array');
    }
    if (doc.schema !== undefined && doc.schema !== 1) {
        throw new Error(`house-models manifest: unsupported schema ${doc.schema}`);
    }
    const models = [];
    const rejected = [];
    const seen = new Set();
    for (const raw of doc.models) {
        const why = [];
        const source = typeof raw?.source === 'string' ? raw.source.trim() : '';
        if (!source || !NAME_RE.test(source)) why.push('source missing or not an Ollama/hf.co reference');
        if (source.includes('..')) why.push('source contains ".."');
        const size = Number(raw?.size_bytes);
        if (!Number.isFinite(size) || size <= 0) why.push('size_bytes must be a positive number');
        const minRam = Number(raw?.min_ram_gb);
        if (!Number.isFinite(minRam) || minRam < 0) why.push('min_ram_gb must be a number');
        const minDisk = raw?.min_disk_gb === undefined ? 0 : Number(raw.min_disk_gb);
        if (!Number.isFinite(minDisk) || minDisk < 0) why.push('min_disk_gb must be a number');
        if (raw?.digest != null && !DIGEST_RE.test(String(raw.digest))) why.push('digest must be sha256 hex');
        const key = normalizeOllamaName(source);
        if (seen.has(key)) why.push('duplicate source');
        if (why.length > 0) {
            rejected.push({ name: raw?.name ?? source ?? '(unnamed)', reasons: why });
            continue;
        }
        seen.add(key);
        models.push({
            name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : source,
            source,
            ollama_name: key,
            digest: raw.digest ? `sha256:${stripDigest(raw.digest)}` : null,
            size_bytes: size,
            min_ram_gb: minRam,
            min_disk_gb: minDisk,
            uncensored: raw.uncensored === true,
            description: typeof raw.description === 'string' ? raw.description : '',
            license: typeof raw.license === 'string' ? raw.license : null,
            added: typeof raw.added === 'string' ? raw.added : null
        });
    }
    return { version: doc.version ?? null, updated: doc.updated ?? null, models, rejected };
}

/** Only HTTPS, only our hosts: a manifest from anywhere else is refused. */
export function assertManifestUrl(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error(`house-models: bad manifest URL ${url}`); }
    if (u.protocol !== 'https:') throw new Error(`house-models: manifest must be https (${url})`);
    if (!ALLOWED_MANIFEST_HOSTS.includes(u.hostname)) {
        throw new Error(`house-models: manifest host ${u.hostname} is not one of ${ALLOWED_MANIFEST_HOSTS.join(', ')}`);
    }
    return u.toString();
}

export async function fetchManifest({ url = DEFAULT_MANIFEST_URL, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
    const safe = assertManifestUrl(url);
    const res = await fetchImpl(safe, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout?.(timeoutMs)
    });
    if (!res.ok) throw new Error(`house-models: GET ${safe} -> HTTP ${res.status}`);
    return parseManifest(await res.json());
}

/**
 * Effective settings: CLI flags beat env, env beats config.json, and the
 * default is ON (house models and uncensored house models both).
 */
export function resolveSettings({ config = {}, env = process.env, args = null } = {}) {
    const cfg = config?.houseModels ?? {};
    let enabled = cfg.enabled !== false;
    let uncensored = cfg.uncensored !== false;
    let maxDiskGb = Number.isFinite(Number(cfg.maxDiskGb)) && cfg.maxDiskGb !== null ? Number(cfg.maxDiskGb) : null;
    const sources = { enabled: cfg.enabled === false ? 'config' : 'default', uncensored: cfg.uncensored === false ? 'config' : 'default' };

    if (isOff(env.INFERNET_HOUSE_MODELS)) { enabled = false; sources.enabled = 'env INFERNET_HOUSE_MODELS'; }
    else if (isOn(env.INFERNET_HOUSE_MODELS)) { enabled = true; sources.enabled = 'env INFERNET_HOUSE_MODELS'; }
    if (isOn(env.INFERNET_NO_HOUSE_MODELS)) { enabled = false; sources.enabled = 'env INFERNET_NO_HOUSE_MODELS'; }
    if (isOff(env.INFERNET_UNCENSORED_MODELS)) { uncensored = false; sources.uncensored = 'env INFERNET_UNCENSORED_MODELS'; }
    else if (isOn(env.INFERNET_UNCENSORED_MODELS)) { uncensored = true; sources.uncensored = 'env INFERNET_UNCENSORED_MODELS'; }
    if (isOn(env.INFERNET_NO_UNCENSORED_MODELS)) { uncensored = false; sources.uncensored = 'env INFERNET_NO_UNCENSORED_MODELS'; }
    const envCap = Number(env.INFERNET_HOUSE_MODELS_MAX_GB);
    if (env.INFERNET_HOUSE_MODELS_MAX_GB !== undefined && env.INFERNET_HOUSE_MODELS_MAX_GB !== '' && Number.isFinite(envCap)) {
        maxDiskGb = envCap;
    }

    if (args?.has?.('no-house-models')) { enabled = false; sources.enabled = '--no-house-models'; }
    if (args?.has?.('no-uncensored-models')) { uncensored = false; sources.uncensored = '--no-uncensored-models'; }
    const argCap = Number(args?.get?.('house-models-max-gb'));
    if (Number.isFinite(argCap) && args?.get?.('house-models-max-gb') !== undefined) maxDiskGb = argCap;

    const manifestUrl = env.INFERNET_HOUSE_MODELS_URL || cfg.manifestUrl || DEFAULT_MANIFEST_URL;
    const intervalMin = Number(env.INFERNET_HOUSE_MODELS_INTERVAL_MIN);
    const intervalMs = Number.isFinite(intervalMin) && intervalMin >= 5 ? intervalMin * 60_000 : DEFAULT_SYNC_INTERVAL_MS;
    return { enabled, uncensored, maxDiskGb: maxDiskGb != null && maxDiskGb >= 0 ? maxDiskGb : null, manifestUrl, intervalMs, sources };
}

/**
 * Free disk a pull must leave behind: 10% of the disk, but at least 10 GB and
 * at most 50 GB (so a 900 GB disk with 80 GB free can still take a 3 GB model).
 */
export function diskReserveBytes(totalBytes) {
    const pct = Number.isFinite(totalBytes) ? totalBytes * DISK_RESERVE_FRACTION : 0;
    return Math.max(DISK_RESERVE_MIN_BYTES, Math.min(pct, DISK_RESERVE_MAX_BYTES));
}

/**
 * Decide what to pull and what to remove. Pure: every input is passed in.
 *
 *   manifest   parseManifest() output
 *   installed  Ollama /api/tags models: [{ name, digest, size }]
 *   owned      { [ollama_name]: {...} }: models the daemon pulled itself
 *   capacity   { ramGb, diskFreeBytes, diskTotalBytes }
 *   settings   resolveSettings() output
 *   failures   { [ollama_name]: { at } }: recent pull/verify failures
 *
 * Returns { pull: [entry], remove: [{ name, reason }], keep: [entry], skipped: [{ name, reason }] }.
 */
export function planSync({ manifest, installed = [], owned = {}, capacity = {}, settings, failures = {}, now = Date.now() }) {
    const installedByName = new Map(installed.map((m) => [normalizeOllamaName(m.name ?? m.model), m]));
    const plan = { pull: [], remove: [], keep: [], skipped: [] };
    const models = manifest?.models ?? [];
    const listed = new Set(models.map((m) => m.ollama_name));

    // Owned models that left the manifest go first, whatever else is set.
    for (const name of Object.keys(owned)) {
        if (!listed.has(name) && installedByName.has(name)) {
            plan.remove.push({ name, reason: 'no longer in the house-models manifest' });
        }
    }

    const ram = Number(capacity.ramGb);
    let free = Number(capacity.diskFreeBytes);
    const reserve = diskReserveBytes(Number(capacity.diskTotalBytes));
    const capBytes = settings?.maxDiskGb != null ? settings.maxDiskGb * GB : Infinity;
    let used = 0;

    for (const m of models) {
        const have = installedByName.get(m.ollama_name);
        const ours = Object.prototype.hasOwnProperty.call(owned, m.ollama_name);
        let reason = null;
        if (!settings?.enabled) reason = 'house models are turned off on this node';
        else if (m.uncensored && !settings.uncensored) reason = 'uncensored house models are turned off on this node';
        else if (Number.isFinite(ram) && ram > 0 && ram < m.min_ram_gb) reason = `needs ${m.min_ram_gb} GB RAM, this node has ${ram.toFixed(1)} GB`;
        else if (used + m.size_bytes > capBytes) reason = `over the house-models disk cap of ${settings.maxDiskGb} GB`;

        if (have) {
            if (reason && ours) plan.remove.push({ name: m.ollama_name, reason });
            else if (reason) plan.skipped.push({ name: m.ollama_name, reason: `${reason} (kept: you installed it yourself)` });
            else { plan.keep.push(m); if (ours) used += m.size_bytes; }
            continue;
        }
        if (reason) { plan.skipped.push({ name: m.ollama_name, reason }); continue; }
        const failed = failures[m.ollama_name];
        if (failed && now - Date.parse(failed.at) < FAILURE_BACKOFF_MS) {
            plan.skipped.push({ name: m.ollama_name, reason: `last attempt failed (${failed.error ?? 'error'}); retrying after 24 h` });
            continue;
        }
        if (Number.isFinite(free)) {
            const needFree = Math.max(m.min_disk_gb * GB, m.size_bytes + reserve);
            if (free < needFree) {
                plan.skipped.push({
                    name: m.ollama_name,
                    reason: `not enough free disk: ${(free / GB).toFixed(1)} GB free, needs ${(needFree / GB).toFixed(1)} GB (model + ${(reserve / GB).toFixed(0)} GB reserve)`
                });
                continue;
            }
            free -= m.size_bytes;
        }
        used += m.size_bytes;
        plan.pull.push(m);
    }
    return plan;
}

/**
 * Check a pulled model against its manifest entry. Ollama's /api/tags digest
 * is the sha256 of the registry manifest, so a pinned digest proves we got
 * exactly the published build. Size must match within 1% (exact for the
 * Ollama registry; the 1% covers registries that recompute small layers).
 */
export function verifyPulled(entry, tagsModel) {
    if (!tagsModel) return { ok: false, error: 'model not listed by Ollama after pull' };
    if (entry.digest) {
        const got = stripDigest(tagsModel.digest);
        if (got !== stripDigest(entry.digest)) {
            return { ok: false, error: `digest mismatch: expected ${entry.digest}, got sha256:${got ?? '?'}` };
        }
    }
    const size = Number(tagsModel.size);
    if (Number.isFinite(size) && size > 0 && Math.abs(size - entry.size_bytes) > entry.size_bytes * 0.01) {
        return { ok: false, error: `size mismatch: expected ${entry.size_bytes} bytes, got ${size}` };
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// State file: what the daemon pulled, the last sync, failures.
// ---------------------------------------------------------------------------

export function getStatePath() {
    return path.join(getConfigDir(), 'house-models-state.json');
}

export function readState(p = getStatePath()) {
    try {
        const s = JSON.parse(fsSync.readFileSync(p, 'utf8'));
        return { owned: s.owned ?? {}, failures: s.failures ?? {}, ...s };
    } catch {
        return { owned: {}, failures: {} };
    }
}

export async function writeState(state, p = getStatePath()) {
    await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o644 });
    await fs.rename(tmp, p);
}

// ---------------------------------------------------------------------------
// Machine probes (Ollama + disk + RAM).
// ---------------------------------------------------------------------------

export function ollamaHost(env = process.env) {
    const h = env.OLLAMA_HOST || 'http://localhost:11434';
    return /^https?:\/\//.test(h) ? h : `http://${h}`;
}

export async function ollamaTags({ host = ollamaHost(), fetchImpl = fetch } = {}) {
    const res = await fetchImpl(new URL('/api/tags', host), { signal: AbortSignal.timeout?.(5000) });
    if (!res.ok) throw new Error(`ollama /api/tags HTTP ${res.status}`);
    const json = await res.json();
    return (Array.isArray(json?.models) ? json.models : []).map((m) => ({
        name: m.name ?? m.model, digest: m.digest ?? null, size: m.size ?? null
    }));
}

export async function ollamaPull(name, { host = ollamaHost(), fetchImpl = fetch, onProgress } = {}) {
    const res = await fetchImpl(new URL('/api/pull', host), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name, name, stream: true })
    });
    if (!res.ok || !res.body) throw new Error(`ollama pull HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let last = null;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const raw = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!raw) continue;
            let line;
            try { line = JSON.parse(raw); } catch { continue; }
            if (line.error) throw new Error(`ollama: ${line.error}`);
            last = line;
            onProgress?.(line);
        }
    }
    if (last?.status !== 'success') throw new Error(`ollama pull ended without success (${last?.status ?? 'no output'})`);
}

export async function ollamaDelete(name, { host = ollamaHost(), fetchImpl = fetch } = {}) {
    const res = await fetchImpl(new URL('/api/delete', host), {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name, name })
    });
    if (!res.ok && res.status !== 404) throw new Error(`ollama delete HTTP ${res.status}`);
}

/** Where Ollama keeps blobs, best guess; used only to measure free disk. */
export function ollamaModelsDir(env = process.env) {
    const candidates = [
        env.OLLAMA_MODELS,
        '/usr/share/ollama/.ollama/models',
        '/var/lib/ollama/.ollama/models',
        '/var/lib/ollama',
        path.join(os.homedir(), '.ollama', 'models')
    ].filter(Boolean);
    for (const c of candidates) {
        try { if (fsSync.statSync(c).isDirectory()) return c; } catch { /* next */ }
    }
    return os.homedir();
}

export async function diskSpace(dir = ollamaModelsDir()) {
    try {
        const s = await fs.statfs(dir);
        return { dir, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
        return { dir, freeBytes: NaN, totalBytes: NaN };
    }
}

export function ramGb() {
    return os.totalmem() / GB;
}

// ---------------------------------------------------------------------------
// One sync pass.
// ---------------------------------------------------------------------------

/**
 * Fetch the manifest, plan, then remove and pull one model at a time.
 * `isBusy()` is checked before each pull so a pull never starts while the
 * node is running a job. Writes the state file. Returns a summary.
 */
export async function syncHouseModels({
    settings,
    fetchImpl = fetch,
    host = ollamaHost(),
    statePath = getStatePath(),
    isBusy = () => false,
    log = () => {},
    capacity = null,
    manifest = null
} = {}) {
    const state = readState(statePath);
    const at = new Date().toISOString();
    const summary = { at, pulled: [], removed: [], skipped: [], errors: [] };
    try {
        const man = manifest ?? await fetchManifest({ url: settings.manifestUrl, fetchImpl });
        for (const r of man.rejected) log(`manifest entry ${r.name} rejected: ${r.reasons.join('; ')}`);
        let installed = await ollamaTags({ host, fetchImpl });
        // Forget ownership of models someone removed by hand.
        const names = new Set(installed.map((m) => normalizeOllamaName(m.name)));
        for (const n of Object.keys(state.owned)) if (!names.has(n)) delete state.owned[n];

        const disk = capacity?.disk ?? await diskSpace();
        const cap = {
            ramGb: capacity?.ramGb ?? ramGb(),
            diskFreeBytes: disk.freeBytes,
            diskTotalBytes: disk.totalBytes
        };
        const plan = planSync({ manifest: man, installed, owned: state.owned, capacity: cap, settings, failures: state.failures });
        summary.skipped = plan.skipped;

        for (const r of plan.remove) {
            try {
                await ollamaDelete(r.name, { host, fetchImpl });
                delete state.owned[r.name];
                summary.removed.push(r);
                log(`removed ${r.name}: ${r.reason}`);
            } catch (err) {
                summary.errors.push({ name: r.name, error: err?.message ?? String(err) });
            }
        }

        for (const m of plan.pull) {
            if (isBusy()) {
                summary.skipped.push({ name: m.ollama_name, reason: 'node busy with a job; next sync' });
                continue;
            }
            log(`pulling ${m.ollama_name} (${(m.size_bytes / GB).toFixed(1)} GB)`);
            try {
                let lastLog = 0;
                await ollamaPull(m.source, {
                    host, fetchImpl,
                    onProgress: (l) => {
                        if (Date.now() - lastLog > 60_000 && l.total) {
                            lastLog = Date.now();
                            log(`  ${m.ollama_name}: ${Math.round((l.completed / l.total) * 100)}%`);
                        }
                    }
                });
                installed = await ollamaTags({ host, fetchImpl });
                const got = installed.find((t) => normalizeOllamaName(t.name) === m.ollama_name);
                const v = verifyPulled(m, got);
                if (!v.ok) {
                    await ollamaDelete(m.ollama_name, { host, fetchImpl }).catch(() => {});
                    throw new Error(`verification failed, removed: ${v.error}`);
                }
                state.owned[m.ollama_name] = { digest: got.digest ?? null, size_bytes: Number(got.size) || m.size_bytes, pulled_at: new Date().toISOString(), uncensored: m.uncensored };
                delete state.failures[m.ollama_name];
                summary.pulled.push(m.ollama_name);
                log(`pulled and verified ${m.ollama_name}`);
            } catch (err) {
                const error = (err?.message ?? String(err)).slice(0, 300);
                state.failures[m.ollama_name] = { at: new Date().toISOString(), error };
                summary.errors.push({ name: m.ollama_name, error });
                log(`pull ${m.ollama_name} failed: ${error}`);
            }
            await writeState({ ...state, last_sync: summary }, statePath).catch(() => {});
        }
        state.manifest = { url: settings.manifestUrl, version: man.version, updated: man.updated, models: man.models.map((m) => m.ollama_name) };
    } catch (err) {
        summary.errors.push({ name: null, error: err?.message ?? String(err) });
        log(`sync failed: ${err?.message ?? err}`);
    }
    state.settings = { enabled: settings.enabled, uncensored: settings.uncensored, maxDiskGb: settings.maxDiskGb };
    state.last_sync = summary;
    await writeState(state, statePath).catch(() => {});
    return summary;
}

/** Human summary for `infernet status` / `infernet house-models status`. */
export function formatStatus({ settings, state, installed = null }) {
    const lines = [];
    const on = settings.enabled ? 'on' : `off (${settings.sources?.enabled ?? 'config'})`;
    const unc = settings.uncensored ? 'on' : `off (${settings.sources?.uncensored ?? 'config'})`;
    const cap = settings.maxDiskGb != null ? `${settings.maxDiskGb} GB` : 'none (always leaves 10% of the disk free, 10-50 GB)';
    lines.push(`House models: ${on}; uncensored: ${unc}; disk cap: ${cap}`);
    const owned = state?.owned ?? {};
    const names = Object.keys(owned);
    const installedNames = installed ? new Set(installed.map((m) => normalizeOllamaName(m.name))) : null;
    let total = 0;
    for (const n of names) {
        const o = owned[n];
        total += Number(o.size_bytes) || 0;
        const gone = installedNames && !installedNames.has(n) ? ' (missing from Ollama)' : '';
        lines.push(`  - ${n}  ${((Number(o.size_bytes) || 0) / GB).toFixed(1)} GB${o.uncensored ? '  [uncensored]' : ''}${gone}`);
    }
    if (names.length === 0) lines.push('  (none pulled yet)');
    lines.push(`  disk used by house models: ${(total / GB).toFixed(1)} GB`);
    const ls = state?.last_sync;
    if (ls?.at) {
        lines.push(`  last sync: ${ls.at}${ls.errors?.length ? `, ${ls.errors.length} error(s): ${ls.errors.map((e) => `${e.name ?? 'manifest'}: ${e.error}`).join('; ')}` : ''}`);
        for (const s of ls.skipped ?? []) lines.push(`  skipped ${s.name}: ${s.reason}`);
    }
    lines.push('  opt out: infernet house-models off  |  uncensored only: infernet house-models uncensored off');
    return lines.join('\n');
}
