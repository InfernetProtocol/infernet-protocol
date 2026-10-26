"""safetensors + ModelManifestV1 export and hash-verified loading."""

import hashlib
import os
import platform
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

from . import RUNTIME_NAME, SCHEMA_VERSION, __version__
from .canonical import file_sha256, manifest_hash
from .errors import LiquidError
from .features import ACTION_TYPES
from .models import TemporalPolicy
from .schema import validate
from .train import now_iso

RUNTIME_DIR = Path(__file__).resolve().parents[1]
WEIGHTS_FILE = "model.safetensors"
MANIFEST_FILE = "manifest.json"


def lock_hash():
    lock = "requirements-cuda.lock" if os.environ.get("INFERNET_LIQUID_LOCK") == "cuda" else "requirements.lock"
    for name in (lock, "pyproject.toml"):
        p = RUNTIME_DIR / name
        if p.exists():
            return "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest()
    return "sha256:" + "0" * 64


def runtime_ref():
    import ncps
    from importlib.metadata import version

    try:
        ncps_v = version("ncps")
    except Exception:
        ncps_v = getattr(ncps, "__version__", "unknown")
    return {
        "name": RUNTIME_NAME,
        "version": __version__,
        "lock_hash": lock_hash(),
        "python": platform.python_version(),
        "torch": torch.__version__,
        "ncps": ncps_v,
    }


def save_model(out_dir, model, info, dataset_hash, eval_metrics, eval_split="test", eval_episodes=0, name=None, train_job_id=None, license="UNLICENSED-private", tasks=None):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    wpath = out / WEIGHTS_FILE
    state = {k: v.detach().cpu().contiguous().clone() for k, v in model.state_dict().items()}
    save_file(state, str(wpath), metadata={"liquid_agent": f"{SCHEMA_VERSION};family={model.family}"})  # one key: safetensors orders a multi-key map randomly
    weights_hash = file_sha256(wpath)
    hp = info["hyperparameters"]
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "kind": "model_manifest",
        "model_id": "lm_" + weights_hash[7:23],
        "created_at": now_iso(),
        "architecture": {
            "family": model.family,
            "hidden_units": model.hidden_units,
            "feature_dim": model.feature_dim,
            "backbone_units": model.backbone_units,
            "params": model.param_count(),
            "research": model.family == "ltc",
        },
        "weights": {"format": "safetensors", "file": WEIGHTS_FILE, "weights_hash": weights_hash, "size_bytes": os.path.getsize(wpath)},
        "runtime": runtime_ref(),
        "input_schema": {"encoding": "hashed-bag/v1", "feature_dim": model.feature_dim, "time_delta": "log1p_seconds", "tasks": sorted(tasks or [])},
        "output_schema": {"action_types": list(ACTION_TYPES), "targets": ["pointer:visible-elements"]},
        "training": {
            "dataset_hash": dataset_hash,
            "seed": int(hp["seed"]),
            "epochs": int(info["epochs_run"]),
            "learning_rate": float(hp["learning_rate"]),
            "device": info["device"],
            "started_at": info["started_at"],
            "finished_at": info["finished_at"],
            "train_seconds": info["train_seconds"],
        },
        "eval": {
            "split": eval_split,
            "episodes": int(eval_episodes),
            "metrics": {k: v for k, v in eval_metrics.items() if isinstance(v, (int, float)) and not isinstance(v, bool)},
        },
        "license": license,
    }
    if name:
        manifest["name"] = name
    if train_job_id:
        manifest["training"]["train_job_id"] = train_job_id
    manifest["manifest_hash"] = manifest_hash(manifest)
    errors = validate(manifest, "model_manifest")
    if errors:
        raise LiquidError("E_SCHEMA", f"exported manifest invalid: {errors[:3]}")
    import json

    (out / MANIFEST_FILE).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", "utf-8")
    return manifest


def read_manifest(model_dir):
    import json

    p = Path(model_dir) / MANIFEST_FILE
    if not p.exists():
        raise LiquidError("E_BAD_REQUEST", f"no {MANIFEST_FILE} in {model_dir}")
    manifest = json.loads(p.read_text("utf-8"))
    errors = validate(manifest, "model_manifest")
    if errors:
        raise LiquidError("E_SCHEMA", "model manifest failed validation: " + "; ".join(f"{a or '/'} {b}" for a, b in errors[:5]))
    if manifest_hash(manifest) != manifest["manifest_hash"]:
        raise LiquidError("E_HASH_MISMATCH", "manifest_hash does not match the manifest")
    return manifest


def load_model(model_dir, expected_hash=None):
    manifest = read_manifest(model_dir)
    wpath = Path(model_dir) / manifest["weights"]["file"]
    if not wpath.exists():
        raise LiquidError("E_BAD_REQUEST", f"weights file missing: {wpath}")
    actual = file_sha256(wpath)
    if actual != manifest["weights"]["weights_hash"]:
        raise LiquidError("E_HASH_MISMATCH", "weights do not match weights_hash in the manifest")
    if expected_hash and expected_hash != actual:
        raise LiquidError("E_MODEL_HASH", f"model hash {actual} is not the requested {expected_hash}")
    a = manifest["architecture"]
    model = TemporalPolicy(a["family"], a["feature_dim"], a["hidden_units"], a.get("backbone_units", 64))
    model.load_state_dict(load_file(str(wpath)), strict=True)
    model.eval()
    return model, manifest
