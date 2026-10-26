import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import torch

from infernet_liquid.canonical import canonicalize, dataset_hash, episode_hash, hash_canonical
from infernet_liquid.data import verify_bundle
from infernet_liquid.errors import LiquidError
from infernet_liquid.export import load_model
from infernet_liquid.schema import validate
from infernet_liquid.secretscan import scan_secrets
from infernet_liquid.server import Server, run_evaluate, run_train
from infernet_liquid.sessions import LoadedModel, SessionManager
from infernet_liquid.synth import make_bundle

RUNTIME = Path(__file__).resolve().parents[1]
FIX = RUNTIME.parent / "fixtures"
SMALL = {"hidden_units": 16, "epochs": 3, "learning_rate": 0.01, "seed": 0, "feature_dim": 64, "backbone_units": 16}


def load(p):
    return json.loads(Path(p).read_text("utf-8"))


class Contract(unittest.TestCase):
    def test_valid_fixtures(self):
        for p in sorted((FIX / "valid").glob("*.json")):
            obj = load(p)
            self.assertEqual(validate(obj), [], p.name)

    def test_invalid_fixtures(self):
        for p in sorted((FIX / "invalid").glob("*.json")):
            f = load(p)
            self.assertNotEqual(validate(f["value"], f["kind"]), [], p.name)

    def test_hash_parity_with_js(self):
        c = load(FIX / "contract.json")
        b = load(FIX / "valid" / "dataset-bundle.json")
        self.assertEqual(dataset_hash(b["manifest"]), c["bundle_dataset_hash"])
        self.assertEqual(episode_hash(b["episodes"][0]), c["episode_content_hash"])
        schemas = {p.name: load(p) for p in sorted((RUNTIME.parent / "schemas").glob("*.schema.json"))}
        self.assertEqual(hash_canonical(schemas), c["schemas_hash"])

    def test_canonical_numbers_match_js(self):
        self.assertEqual(canonicalize({"b": 1.0, "a": [0.5, 1e21, 1e-7, -0.0, 3]}), '{"a":[0.5,1e+21,1e-7,0,3],"b":1}')
        self.assertEqual(canonicalize("é\n "), '"é\\n "')

    def test_tampered_bundle_rejected(self):
        b = load(FIX / "valid" / "dataset-bundle.json")
        verify_bundle(b)
        t = copy.deepcopy(b)
        t["episodes"][0]["labels"]["risk"] = "high"
        with self.assertRaises(LiquidError) as e:
            verify_bundle(t)
        self.assertEqual(e.exception.code, "E_HASH_MISMATCH")

    def test_secret_scan(self):
        self.assertEqual(scan_secrets({"text": "see you at 3"}), [])
        hits = scan_secrets({"steps": [{"action": {"text": "password: hunter22"}}], "x": "4111 1111 1111 1111", "t_ms": "4111111111111111"})
        kinds = {k for h in hits for k in h["kinds"]}
        self.assertEqual(kinds, {"password_assignment", "card_number"})


class Training(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = make_bundle(per_task=12, seed=5)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.models = {}
        for fam in ("cfc", "gru", "ltc"):
            out = Path(cls.tmp.name) / fam
            cls.models[fam] = run_train({"bundle": cls.bundle, "family": fam, "output_dir": str(out), "hyperparameters": SMALL, "max_threads": 2})

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_manifests_valid_and_loadable(self):
        for fam, res in self.models.items():
            m = res["manifest"]
            self.assertEqual(validate(m), [], fam)
            self.assertEqual(m["architecture"]["family"], fam)
            self.assertEqual(m["architecture"]["research"], fam == "ltc")
            model, _ = load_model(res["model_dir"], m["weights"]["weights_hash"])
            self.assertEqual(model.family, fam)

    def test_reproducible_weights(self):
        with tempfile.TemporaryDirectory() as d:
            again = run_train({"bundle": self.bundle, "family": "cfc", "output_dir": d, "hyperparameters": SMALL, "max_threads": 2})
        self.assertEqual(again["manifest"]["weights"]["weights_hash"], self.models["cfc"]["manifest"]["weights"]["weights_hash"])

    def test_wrong_model_hash_and_tampered_weights(self):
        res = self.models["gru"]
        with self.assertRaises(LiquidError) as e:
            load_model(res["model_dir"], "sha256:" + "0" * 64)
        self.assertEqual(e.exception.code, "E_MODEL_HASH")
        with tempfile.TemporaryDirectory() as d:
            import shutil

            shutil.copytree(res["model_dir"], d, dirs_exist_ok=True)
            w = Path(d) / "model.safetensors"
            data = bytearray(w.read_bytes())
            data[-1] ^= 1
            w.write_bytes(bytes(data))
            with self.assertRaises(LiquidError) as e:
                load_model(d)
            self.assertEqual(e.exception.code, "E_HASH_MISMATCH")

    def test_evaluate_matches_training_report(self):
        res = self.models["cfc"]
        ev = run_evaluate({"model_dir": res["model_dir"], "bundle": self.bundle, "split": "test"})
        self.assertEqual(ev["metrics"]["step_accuracy"], res["eval"]["metrics"]["step_accuracy"])

    def test_job_consent_and_hash(self):
        job = load(FIX / "valid" / "train-job.json")
        job["dataset_hash"] = self.bundle["manifest"]["dataset_hash"]
        job["privacy"] = {"mode": "trusted_worker", "upload_approved": False}
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(LiquidError) as e:
                run_train({"bundle": self.bundle, "job": job, "output_dir": d})
            self.assertEqual(e.exception.code, "E_CONSENT")
            job["privacy"]["upload_approved"] = True
            job["dataset_hash"] = "sha256:" + "1" * 64
            with self.assertRaises(LiquidError) as e:
                run_train({"bundle": self.bundle, "job": job, "output_dir": d})
            self.assertEqual(e.exception.code, "E_HASH_MISMATCH")

    def _sm(self, fam="cfc", clock=None):
        model, manifest = load_model(self.models[fam]["model_dir"])
        sm = SessionManager(max_sessions=2, default_ttl_s=60, clock=clock or (lambda: 1000.0))
        lm = LoadedModel(model, manifest, abstain_threshold=0.0)
        sm.add_model(lm)
        return sm, lm

    def _req(self, sid, idx, ep, prev=None):
        st = ep["steps"][idx]
        dt = st["t_ms"] - ep["steps"][idx - 1]["t_ms"] if idx else 0
        return {"schema_version": "liquid-agent/v1", "kind": "predict_request", "session_id": sid, "sequence_index": idx,
                "dt_ms": dt, "task": ep["task"], "observation": st["observation"], "prev_action": prev}

    def test_sequence_rules(self):
        sm, lm = self._sm()
        ep = self.bundle["episodes"][0]
        sm.open(lm.hash, "s1")
        p = sm.predict(self._req("s1", 0, ep))
        self.assertEqual(validate(p), [])
        for idx, code in ((0, "E_SEQ_DUPLICATE"), (2, "E_SEQ_GAP")):
            with self.assertRaises(LiquidError) as e:
                sm.predict(self._req("s1", idx, ep))
            self.assertEqual(e.exception.code, code)
        sm.predict(self._req("s1", 1, ep, ep["steps"][0]["action"]))
        with self.assertRaises(LiquidError) as e:
            sm.predict(self._req("s1", 0, ep))
        self.assertEqual(e.exception.code, "E_SEQ_LATE")
        sm.reset("s1")
        self.assertEqual(sm.predict(self._req("s1", 0, ep))["sequence_index"], 0)

    def test_ttl_capacity_scope(self):
        now = [1000.0]
        sm, lm = self._sm(clock=lambda: now[0])
        sm.open(lm.hash, "a", ttl_s=10, account_scope="acct-1")
        sm.open(lm.hash, "b")
        with self.assertRaises(LiquidError) as e:
            sm.open(lm.hash, "c")
        self.assertEqual(e.exception.code, "E_CAPACITY")
        with self.assertRaises(LiquidError) as e:
            sm.get("a", account_scope="acct-2")
        self.assertEqual(e.exception.code, "E_SESSION_UNKNOWN")
        now[0] += 11
        with self.assertRaises(LiquidError) as e:
            sm.get("a")
        self.assertEqual(e.exception.code, "E_SESSION_EXPIRED")
        sm.open(lm.hash, "c")

    def test_checkpoint_restore_is_equivalent(self):
        ep = self.bundle["episodes"][1]
        sm, lm = self._sm("gru")
        sm.open(lm.hash, "x")
        prev = None
        for i in range(3):
            sm.predict(self._req("x", i, ep, prev))
            prev = ep["steps"][i]["action"]
        with tempfile.TemporaryDirectory() as d:
            ck = sm.checkpoint("x", d)
            sm2, _ = self._sm("gru")
            restored = sm2.restore(ck["path"])
            self.assertEqual(restored["sequence_index"], 2)
            a = sm.predict(self._req("x", 3, ep, prev))
            b = sm2.predict(self._req("x", 3, ep, prev))
        self.assertEqual(a["action"], b["action"])
        self.assertAlmostEqual(a["confidence"], b["confidence"], places=5)

    def test_kill_switch_and_external_write_approval(self):
        sm, lm = self._sm()
        ep = self.bundle["episodes"][0]
        sm.open(lm.hash, "k")
        p = sm.predict(self._req("k", 0, ep), kill_switch=True)
        self.assertIsNone(p["action"])
        self.assertEqual(p["abstain_reason"], "kill_switch")
        sm.open(lm.hash, "w")
        reddit = next(e for e in self.bundle["episodes"] if e["task"] == "reddit.post_compose")
        prev = None
        for i, st in enumerate(reddit["steps"]):
            p = sm.predict(self._req("w", i, reddit, prev))
            if p["action"] and p["action"]["type"] in ("post", "send", "publish", "delete", "submit"):
                self.assertTrue(p["requires_approval"])
            prev = st["action"]


class StdioContract(unittest.TestCase):
    def test_serve_over_pipes(self):
        bundle = make_bundle(per_task=6, seed=9)
        with tempfile.TemporaryDirectory() as d:
            bpath = Path(d) / "b.json"
            bpath.write_text(json.dumps(bundle))
            reqs = [
                {"v": 1, "id": "h", "op": "health"},
                {"v": 2, "id": "bad", "op": "health"},
                {"v": 1, "id": "u", "op": "nope"},
                {"v": 1, "id": "val", "op": "validate", "bundle_path": str(bpath)},
            ]
            p = subprocess.run([sys.executable, "-m", "infernet_liquid", "serve"], input="\n".join(json.dumps(r) for r in reqs) + "\n",
                               capture_output=True, text=True, cwd=RUNTIME, timeout=120)
            out = {m["id"]: m for m in map(json.loads, p.stdout.splitlines())}
            self.assertTrue(out["h"]["ok"])
            self.assertEqual(out["bad"]["error"]["code"], "E_BAD_REQUEST")
            self.assertEqual(out["u"]["error"]["code"], "E_BAD_REQUEST")
            self.assertEqual(out["val"]["result"]["dataset_hash"], bundle["manifest"]["dataset_hash"])
            self.assertNotIn("From ", p.stderr)  # no dataset content in logs


if __name__ == "__main__":
    unittest.main()
