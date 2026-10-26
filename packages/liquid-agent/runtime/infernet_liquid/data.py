"""Load, verify and tensorise DatasetBundleV1 files."""

import json

import torch

from .canonical import dataset_hash, episode_hash
from .errors import LiquidError
from .features import ACTION_TYPES, ELEMENT_DIM, MAX_ELEMENTS, encode_element, encode_step, target_index
from .schema import validate
from .secretscan import scan_secrets


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise LiquidError("E_BAD_REQUEST", f"file not found: {path}")
    except json.JSONDecodeError as e:
        raise LiquidError("E_SCHEMA", f"{path} is not JSON: {e}")


def verify_bundle(bundle):
    """Schema, every hash, manifest/episode agreement and the secret scan. Returns the dataset hash."""
    errors = validate(bundle, "dataset_bundle")
    if errors:
        raise LiquidError("E_SCHEMA", "dataset bundle failed liquid-agent/v1 validation: " + "; ".join(f"{p or '/'} {m}" for p, m in errors[:5]))
    eps = {e["episode_id"]: e for e in bundle["episodes"]}
    if len(eps) != len(bundle["episodes"]):
        raise LiquidError("E_SCHEMA", "duplicate episode_id in bundle")
    manifest = bundle["manifest"]
    if len(manifest["episodes"]) != len(eps):
        raise LiquidError("E_HASH_MISMATCH", "bundle carries episodes the manifest does not name")
    for entry in manifest["episodes"]:
        ep = eps.get(entry["episode_id"])
        if ep is None:
            raise LiquidError("E_HASH_MISMATCH", f"manifest names {entry['episode_id']} but the bundle lacks it")
        if ep["content_hash"] != entry["content_hash"] or episode_hash(ep) != ep["content_hash"]:
            raise LiquidError("E_HASH_MISMATCH", f"episode {entry['episode_id']} does not match its hash")
    if dataset_hash(manifest) != manifest["dataset_hash"]:
        raise LiquidError("E_HASH_MISMATCH", "dataset_hash does not match the manifest")
    hits = scan_secrets(bundle["episodes"])
    if hits:
        raise LiquidError("E_SECRET_DETECTED", f"dataset contains what looks like a secret at {hits[0]['path']} ({','.join(hits[0]['kinds'])})")
    return manifest["dataset_hash"]


def split_episodes(bundle):
    eps = {e["episode_id"]: e for e in bundle["episodes"]}
    out = {"train": [], "validation": [], "test": []}
    for entry in bundle["manifest"]["episodes"]:
        out[entry["split"]].append(eps[entry["episode_id"]])
    return out


def encode_episode(ep, feature_dim):
    xs, dts, elems, masks, y_type, y_ptr, needs = [], [], [], [], [], [], []
    hidden_targets = 0
    prev, prev_t = None, None
    for step in ep["steps"]:
        dt_ms = 0 if prev_t is None else max(0, step["t_ms"] - prev_t)
        obs = step["observation"]
        xs.append(encode_step(ep["task"], obs, prev, dt_ms, feature_dim))
        dts.append([min(dt_ms / 1000.0, 60.0)])
        els = (obs.get("elements") or [])[:MAX_ELEMENTS]
        elems.append([encode_element(el, i) for i, el in enumerate(els)])
        masks.append(len(els))
        y_type.append(ACTION_TYPES.index(step["action"]["type"]))
        needs.append(bool(step["action"].get("target")))
        ti = target_index(obs, step["action"])
        if ti is None:
            hidden_targets += 1
            ti = -100
        elif ti == -1:
            ti = -100
        y_ptr.append(ti)
        prev, prev_t = step["action"], step["t_ms"]
    return {
        "episode_id": ep["episode_id"],
        "task": ep["task"],
        "variant": ep.get("variant"),
        "x": xs,
        "dt": dts,
        "elems": elems,
        "n_elems": masks,
        "y_type": y_type,
        "y_ptr": y_ptr,
        "needs_target": needs,
        "hidden_targets": hidden_targets,
    }


def collate(encoded):
    """Pad a list of encoded episodes into batch tensors."""
    B = len(encoded)
    T = max(len(e["x"]) for e in encoded)
    F = len(encoded[0]["x"][0])
    E = max(1, max(max(e["n_elems"]) if e["n_elems"] else 0 for e in encoded))
    x = torch.zeros(B, T, F)
    dt = torch.zeros(B, T, 1)
    elems = torch.zeros(B, T, E, ELEMENT_DIM)
    emask = torch.zeros(B, T, E, dtype=torch.bool)
    smask = torch.zeros(B, T, dtype=torch.bool)
    y_type = torch.full((B, T), -100, dtype=torch.long)
    y_ptr = torch.full((B, T), -100, dtype=torch.long)
    for b, e in enumerate(encoded):
        t = len(e["x"])
        x[b, :t] = torch.tensor(e["x"])
        dt[b, :t] = torch.tensor(e["dt"])
        smask[b, :t] = True
        y_type[b, :t] = torch.tensor(e["y_type"])
        y_ptr[b, :t] = torch.tensor(e["y_ptr"])
        for s, (vecs, n) in enumerate(zip(e["elems"], e["n_elems"])):
            if n:
                elems[b, s, :n] = torch.tensor(vecs)
                emask[b, s, :n] = True
    # A step with no visible elements still needs one finite pointer slot.
    empty = ~emask.any(-1)
    emask[..., 0] |= empty
    return {"x": x, "dt": dt, "elems": elems, "emask": emask, "smask": smask, "y_type": y_type, "y_ptr": y_ptr}
