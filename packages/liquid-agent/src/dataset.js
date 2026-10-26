/**
 * Build liquid-agent/v1 episodes, manifests and bundles.
 *
 * Splits are assigned per split_group (recording session, account or variant)
 * so one group never straddles train and test, deterministically from a seed.
 */

import { SCHEMA_VERSION } from "./contract.js";
import { datasetHash, episodeHash, sha256Hex } from "./canonical.js";
import { assertNoSecrets, SCANNER_VERSION } from "./secrets.js";
import { assertValid } from "./validate.js";

export function sealEpisode(episode) {
    const e = { ...episode, schema_version: SCHEMA_VERSION, kind: "episode" };
    delete e.content_hash;
    return { ...e, content_hash: episodeHash(e) };
}

function groupOf(ep, strategy) {
    switch (strategy) {
        case "by_task":
            return ep.task;
        case "by_variant":
            return ep.variant ?? ep.split_group ?? ep.episode_id;
        default:
            return ep.split_group ?? ep.episode_id;
    }
}

/** Stable split for a group: hash(seed, group) → [0,1). */
function bucket(seed, group) {
    return parseInt(sha256Hex(`${seed}:${group}`).slice(0, 8), 16) / 0x100000000;
}

export function assignSplits(episodes, { strategy = "by_session", seed = 0, validation = 0.15, test = 0.2 } = {}) {
    return episodes.map((ep) => {
        const g = groupOf(ep, strategy);
        const b = bucket(seed, g);
        const split = b < test ? "test" : b < test + validation ? "validation" : "train";
        return { ep, split, group: g };
    });
}

/**
 * Build a DatasetBundleV1 from sealed episodes. Throws on schema errors, hash
 * mismatches, unreviewed episodes or anything the secret scan flags.
 */
export function buildBundle(episodes, opts = {}) {
    const {
        datasetId,
        name,
        version = 1,
        license = "UNLICENSED-private",
        provenance = { source: "w3bs" },
        consent,
        retention = { days: null, delete_on_revoke: true },
        redactionProfile = "strict",
        strategy = "by_session",
        seed = 0,
        validation,
        test,
        requireReviewed = true,
        createdAt = new Date().toISOString()
    } = opts;
    if (!consent?.consent_id) {
        const err = new Error("dataset needs a consent record (consent_id, purposes, granted_at)");
        err.code = "E_CONSENT";
        throw err;
    }
    for (const ep of episodes) {
        assertValid(ep, "episode");
        if (episodeHash(ep) !== ep.content_hash) {
            const err = new Error(`episode ${ep.episode_id} content_hash does not match its content`);
            err.code = "E_HASH_MISMATCH";
            throw err;
        }
        if (requireReviewed && !ep.labels.reviewed) {
            const err = new Error(`episode ${ep.episode_id} has not been reviewed`);
            err.code = "E_CONSENT";
            throw err;
        }
        assertNoSecrets(ep, `episode ${ep.episode_id}`);
    }
    const assigned = assignSplits(episodes, { strategy, seed, validation, test });
    const counts = { train: 0, validation: 0, test: 0 };
    for (const a of assigned) counts[a.split] += 1;
    const manifest = {
        schema_version: SCHEMA_VERSION,
        kind: "dataset_manifest",
        dataset_id: datasetId ?? `ds_${sha256Hex(assigned.map((a) => a.ep.content_hash).join(",")).slice(0, 16)}`,
        ...(name ? { name } : {}),
        version,
        created_at: createdAt,
        episodes: assigned.map((a) => ({
            episode_id: a.ep.episode_id,
            content_hash: a.ep.content_hash,
            task: a.ep.task,
            split: a.split,
            split_group: String(a.group).slice(0, 128)
        })),
        splits: { strategy, seed, counts },
        license,
        provenance,
        consent,
        retention,
        redaction: { profile: redactionProfile, secret_scan: "passed", scanner_version: SCANNER_VERSION }
    };
    manifest.dataset_hash = datasetHash(manifest);
    const bundle = { schema_version: SCHEMA_VERSION, kind: "dataset_bundle", manifest, episodes };
    assertValid(bundle, "dataset_bundle");
    return bundle;
}

/**
 * Full integrity check of a bundle: schema, every episode hash, manifest ↔
 * episode agreement, dataset_hash, secret scan. Returns the dataset hash.
 */
export function verifyBundle(bundle) {
    assertValid(bundle, "dataset_bundle");
    const byId = new Map(bundle.episodes.map((e) => [e.episode_id, e]));
    if (byId.size !== bundle.episodes.length) throw Object.assign(new Error("duplicate episode_id in bundle"), { code: "E_SCHEMA" });
    for (const entry of bundle.manifest.episodes) {
        const ep = byId.get(entry.episode_id);
        if (!ep) throw Object.assign(new Error(`manifest names ${entry.episode_id} but the bundle lacks it`), { code: "E_HASH_MISMATCH" });
        if (ep.content_hash !== entry.content_hash || episodeHash(ep) !== ep.content_hash) {
            throw Object.assign(new Error(`episode ${entry.episode_id} does not match its hash`), { code: "E_HASH_MISMATCH" });
        }
    }
    if (bundle.manifest.episodes.length !== bundle.episodes.length) throw Object.assign(new Error("bundle carries episodes the manifest does not name"), { code: "E_HASH_MISMATCH" });
    if (datasetHash(bundle.manifest) !== bundle.manifest.dataset_hash) throw Object.assign(new Error("dataset_hash does not match the manifest"), { code: "E_HASH_MISMATCH" });
    assertNoSecrets(bundle.episodes, "dataset");
    return bundle.manifest.dataset_hash;
}
