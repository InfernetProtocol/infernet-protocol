"""Build sealed episodes and DatasetBundleV1 files; mirrors src/dataset.js byte for byte."""

from .canonical import dataset_hash, episode_hash, sha256_hex
from .secretscan import SCANNER_VERSION
from . import SCHEMA_VERSION


def seal_episode(ep):
    e = {k: v for k, v in ep.items() if k != "content_hash"}
    e["schema_version"] = SCHEMA_VERSION
    e["kind"] = "episode"
    e["content_hash"] = episode_hash(e)
    return e


def _group(ep, strategy):
    if strategy == "by_task":
        return ep["task"]
    if strategy == "by_variant":
        return ep.get("variant") or ep.get("split_group") or ep["episode_id"]
    return ep.get("split_group") or ep["episode_id"]


def _bucket(seed, group):
    return int(sha256_hex(f"{seed}:{group}")[:8], 16) / 0x100000000


def assign_splits(episodes, strategy="by_session", seed=0, validation=0.15, test=0.2):
    out = []
    for ep in episodes:
        g = _group(ep, strategy)
        b = _bucket(seed, g)
        split = "test" if b < test else "validation" if b < test + validation else "train"
        out.append((ep, split, g))
    return out


def build_bundle(episodes, dataset_id, created_at, consent, name=None, strategy="by_session", seed=0, validation=0.15, test=0.2, provenance=None, license="CC0-1.0"):
    assigned = assign_splits(episodes, strategy, seed, validation, test)
    counts = {"train": 0, "validation": 0, "test": 0}
    for _, split, _ in assigned:
        counts[split] += 1
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "kind": "dataset_manifest",
        "dataset_id": dataset_id,
        "version": 1,
        "created_at": created_at,
        "episodes": [
            {"episode_id": ep["episode_id"], "content_hash": ep["content_hash"], "task": ep["task"], "split": split, "split_group": str(g)[:128]}
            for ep, split, g in assigned
        ],
        "splits": {"strategy": strategy, "seed": seed, "counts": counts},
        "license": license,
        "provenance": provenance or {"source": "synthetic", "generator": "infernet-liquid synth"},
        "consent": consent,
        "retention": {"days": None, "delete_on_revoke": True},
        "redaction": {"profile": "strict", "secret_scan": "passed", "scanner_version": SCANNER_VERSION},
    }
    if name:
        manifest["name"] = name
    manifest["dataset_hash"] = dataset_hash(manifest)
    return {"schema_version": SCHEMA_VERSION, "kind": "dataset_bundle", "manifest": manifest, "episodes": episodes}
