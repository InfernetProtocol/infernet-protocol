"""Regenerate fixtures/valid and fixtures/invalid. Run from runtime/: python -m tests.make_fixtures"""

import copy
import json
import tempfile
from pathlib import Path

from infernet_liquid.canonical import hash_canonical
from infernet_liquid.server import run_train
from infernet_liquid.synth import make_bundle

ROOT = Path(__file__).resolve().parents[2] / "fixtures"
V, I = ROOT / "valid", ROOT / "invalid"


def dump(path, obj):
    path.write_text(json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n", "utf-8")


def main():
    V.mkdir(parents=True, exist_ok=True)
    I.mkdir(parents=True, exist_ok=True)
    bundle = make_bundle(per_task=4, seed=3)
    dump(V / "dataset-bundle.json", bundle)
    dump(V / "dataset-manifest.json", bundle["manifest"])
    dump(V / "episode.json", bundle["episodes"][0])
    job = {
        "schema_version": "liquid-agent/v1", "kind": "train_job", "job_id": "tj_fixture_0001",
        "idempotency_key": "fixture-0001-idem", "created_at": "2026-10-25T12:00:00Z",
        "dataset_hash": bundle["manifest"]["dataset_hash"], "dataset_ref": "dataset-bundle.json",
        "model_type": "cfc", "baselines": ["gru"],
        "hyperparameters": {"hidden_units": 16, "epochs": 2, "learning_rate": 0.005, "seed": 0, "batch_size": 8, "feature_dim": 64},
        "resources": {"device": "cpu", "gpu_required": False, "min_ram_mb": 512, "max_threads": 2},
        "limits": {"timeout_s": 600, "max_retries": 1, "max_budget_usd": 0},
        "privacy": {"mode": "local_only", "upload_approved": False},
        "retention": {"artifact_days": 30, "delete_dataset_after": True},
    }
    dump(V / "train-job.json", job)
    with tempfile.TemporaryDirectory() as d:
        res = run_train({"bundle": bundle, "job": job, "output_dir": d})
    manifest = res["manifest"]
    dump(V / "model-manifest.json", manifest)
    mh = manifest["weights"]["weights_hash"]
    session = {
        "schema_version": "liquid-agent/v1", "kind": "inference_session", "session_id": "sess-fixture-1",
        "model_hash": mh, "created_at": "2026-10-25T12:00:00.000Z", "expires_at": "2026-10-25T12:10:00.000Z",
        "ttl_s": 600, "sequence_index": -1, "state": "active", "checkpoint_ref": None, "worker": "local",
    }
    dump(V / "inference-session.json", session)
    step = bundle["episodes"][0]["steps"][0]
    req = {
        "schema_version": "liquid-agent/v1", "kind": "predict_request", "session_id": "sess-fixture-1", "model_hash": mh,
        "sequence_index": 0, "dt_ms": 0, "task": bundle["episodes"][0]["task"], "observation": step["observation"], "prev_action": None,
    }
    dump(V / "predict-request.json", req)
    prop = {
        "schema_version": "liquid-agent/v1", "kind": "action_proposal", "session_id": "sess-fixture-1", "sequence_index": 3,
        "model_hash": mh, "action": {"type": "post", "target": {"role": "button", "name": "Post"}},
        "confidence": 0.91, "uncertainty": 0.12, "alternatives": [{"action": {"type": "wait"}, "p": 0.05}],
        "requires_approval": True, "abstain_reason": None, "latency_ms": 0.2,
    }
    dump(V / "action-proposal.json", prop)

    # invalid: each file says which rule it breaks
    def bad(name, obj, why):
        dump(I / f"{name}.json", {"why": why, "kind": obj.get("kind"), "value": obj})

    ep = copy.deepcopy(bundle["episodes"][0])
    ep["steps"][0]["action"]["type"] = "teleport"
    bad("episode-unknown-action", ep, "action type outside the enum")
    ep = copy.deepcopy(bundle["episodes"][0])
    ep["cookies"] = "sid=1"
    bad("episode-extra-field", ep, "additionalProperties false")
    ep = copy.deepcopy(bundle["episodes"][0])
    del ep["capture"]
    bad("episode-no-capture", ep, "capture (consent) is required")
    j = copy.deepcopy(job)
    j["model_type"] = "transformer"
    bad("train-job-bad-family", j, "model_type must be cfc, ltc or gru")
    j = copy.deepcopy(job)
    j["hyperparameters"]["learning_rate"] = 0
    bad("train-job-zero-lr", j, "learning_rate exclusiveMinimum 0")
    m = copy.deepcopy(manifest)
    m["weights"]["weights_hash"] = "md5:abc"
    bad("model-manifest-bad-hash", m, "weights_hash must be sha256:<64 hex>")
    s = copy.deepcopy(session)
    s["sequence_index"] = -2
    bad("session-bad-seq", s, "sequence_index minimum -1")
    p = copy.deepcopy(prop)
    p["confidence"] = 1.5
    bad("proposal-confidence-range", p, "confidence maximum 1")
    p = copy.deepcopy(prop)
    p["abstain_reason"] = "felt_like_it"
    bad("proposal-bad-abstain", p, "abstain_reason enum")
    r = copy.deepcopy(req)
    r["sequence_index"] = -1
    bad("predict-negative-seq", r, "request sequence_index minimum 0")

    contract = {
        "schema_version": "liquid-agent/v1",
        "schemas_hash": hash_canonical({p.name: json.loads(p.read_text("utf-8")) for p in sorted((ROOT.parent / "schemas").glob("*.schema.json"))}),
        "bundle_dataset_hash": bundle["manifest"]["dataset_hash"],
        "episode_content_hash": bundle["episodes"][0]["content_hash"],
    }
    dump(ROOT / "contract.json", contract)
    print(json.dumps(contract, indent=2))


if __name__ == "__main__":
    main()
