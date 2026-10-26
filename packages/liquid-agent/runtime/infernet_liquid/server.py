"""stdio NDJSON server: the subprocess contract Infernet speaks to this runtime.

Request:  {"v":1, "id":"r1", "op":"predict", ...params}
Response: {"v":1, "id":"r1", "ok":true, "result":{...}}
          {"v":1, "id":"r1", "ok":false, "error":{"code","message","retriable"}}
Events:   {"v":1, "id":"r1", "event":"epoch", ...}   (train/evaluate progress)

train and evaluate run on worker threads so health, cancel and predict stay
responsive. Nothing from a dataset or observation is written to stderr.
"""

import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path

from . import PROTOCOL_VERSION, SCHEMA_VERSION, __version__
from .data import load_json, split_episodes, verify_bundle
from .errors import LiquidError
from .export import load_model, read_manifest, runtime_ref, save_model
from .schema import validate
from .sessions import LoadedModel, SessionManager

LONG_OPS = {"train", "evaluate"}


def devices():
    import torch

    mps = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    return {"cpu": True, "cuda": torch.cuda.is_available(), "cuda_devices": torch.cuda.device_count() if torch.cuda.is_available() else 0, "mps": mps}


def ram_mb():
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") // (1024 * 1024)
    except (ValueError, OSError, AttributeError):
        return 0


def _bundle(params):
    if "bundle" in params:
        return params["bundle"]
    if "bundle_path" in params:
        return load_json(params["bundle_path"])
    raise LiquidError("E_BAD_REQUEST", "bundle_path is required")


def run_train(params, on_event=None, cancelled=None):
    from .evaluate import evaluate_encoded
    from .train import train

    bundle = _bundle(params)
    dhash = verify_bundle(bundle)
    job = params.get("job")
    family = params.get("family", "cfc")
    hp = dict(params.get("hyperparameters") or {})
    device = params.get("device", "auto")
    threads = params.get("max_threads")
    timeout_s = params.get("timeout_s")
    job_id = None
    if job:
        errors = validate(job, "train_job")
        if errors:
            raise LiquidError("E_SCHEMA", "train job failed validation: " + "; ".join(f"{a or '/'} {b}" for a, b in errors[:5]))
        if job["dataset_hash"] != dhash:
            raise LiquidError("E_HASH_MISMATCH", f"job names dataset {job['dataset_hash']} but the bundle is {dhash}")
        if job["privacy"]["mode"] == "trusted_worker" and not job["privacy"]["upload_approved"]:
            raise LiquidError("E_CONSENT", "remote training needs upload_approved in the job's privacy block")
        family = job["model_type"]
        hp.update(job["hyperparameters"])
        device = job["resources"]["device"]
        threads = job["resources"].get("max_threads", threads)
        timeout_s = job["limits"]["timeout_s"]
        job_id = job["job_id"]
    if family not in ("cfc", "ltc", "gru"):
        raise LiquidError("E_BAD_REQUEST", f"unknown family {family}")
    if "consent" in bundle["manifest"] and "model_training" not in bundle["manifest"]["consent"]["purposes"]:
        raise LiquidError("E_CONSENT", "dataset consent does not cover model_training")
    deadline = time.monotonic() + float(timeout_s) if timeout_s else None
    model, info = train(bundle, family, hp, device, threads, on_event, cancelled, deadline)
    enc = info["encoded"]
    split = "test" if enc["test"] else "validation"
    metrics = evaluate_encoded(model, enc[split] or enc["train"])
    tasks = sorted({e["task"] for e in bundle["episodes"]})
    out = params.get("output_dir")
    if not out:
        raise LiquidError("E_BAD_REQUEST", "output_dir is required")
    manifest = save_model(out, model, info, dhash, metrics, split, len(enc[split]), params.get("name"), job_id, params.get("license", "UNLICENSED-private"), tasks)
    report = {"model_hash": manifest["weights"]["weights_hash"], "dataset_hash": dhash, "split": split, "metrics": metrics}
    Path(out, "eval.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")
    return {"model_dir": str(out), "manifest": manifest, "eval": report}


def run_evaluate(params, on_event=None, cancelled=None):
    from .data import encode_episode
    from .evaluate import evaluate_encoded

    model, manifest = load_model(params["model_dir"], params.get("expected_hash"))
    bundle = _bundle(params)
    dhash = verify_bundle(bundle)
    split = params.get("split", "test")
    eps = split_episodes(bundle)[split] if split != "all" else bundle["episodes"]
    if not eps:
        raise LiquidError("E_BAD_REQUEST", f"dataset has no {split} episodes")
    enc = [encode_episode(e, manifest["architecture"]["feature_dim"]) for e in eps]
    metrics = evaluate_encoded(model, enc)
    return {"model_hash": manifest["weights"]["weights_hash"], "dataset_hash": dhash, "split": split, "metrics": metrics}


class Server:
    def __init__(self, inp=sys.stdin, out=sys.stdout, max_sessions=64, ttl_s=600, worker="local"):
        self.inp = inp
        self.out = out
        self.out_lock = threading.Lock()
        self.sm = SessionManager(max_sessions=max_sessions, default_ttl_s=ttl_s, worker=worker)
        self.jobs = {}
        self.kill_switch = False
        self.running = True

    def send(self, obj):
        line = json.dumps({"v": PROTOCOL_VERSION, **obj}, separators=(",", ":"))
        with self.out_lock:
            self.out.write(line + "\n")
            self.out.flush()

    def ok(self, rid, result):
        self.send({"id": rid, "ok": True, "result": result})

    def fail(self, rid, err):
        self.send({"id": rid, "ok": False, "error": err.to_json() if isinstance(err, LiquidError) else {"code": "E_RUNTIME", "message": str(err), "retriable": True}})

    def serve(self):
        for line in self.inp:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except ValueError:
                self.fail(None, LiquidError("E_BAD_REQUEST", "request is not JSON"))
                continue
            self.handle(req)
            if not self.running:
                break
        for ev in self.jobs.values():
            ev.set()

    def handle(self, req):
        rid = req.get("id")
        if req.get("v") != PROTOCOL_VERSION:
            return self.fail(rid, LiquidError("E_BAD_REQUEST", f"protocol version must be {PROTOCOL_VERSION}"))
        op = req.get("op")
        if op in LONG_OPS:
            ev = threading.Event()
            self.jobs[rid] = ev
            threading.Thread(target=self._long, args=(rid, op, req, ev), daemon=True).start()
            return
        try:
            self.ok(rid, self.dispatch(op, req))
        except LiquidError as e:
            self.fail(rid, e)
        except Exception as e:  # noqa: BLE001 - reported to the caller, never crash the loop
            traceback.print_exc(file=sys.stderr)
            self.fail(rid, e)

    def _long(self, rid, op, req, ev):
        fn = run_train if op == "train" else run_evaluate
        try:
            res = fn(req, on_event=lambda e: self.send({"id": rid, **e}), cancelled=ev.is_set)
            self.ok(rid, res)
        except LiquidError as e:
            self.fail(rid, e)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            self.fail(rid, e)
        finally:
            self.jobs.pop(rid, None)

    def dispatch(self, op, p):
        sm = self.sm
        scope = p.get("account_scope")
        if op == "health":
            return {
                "status": "ok",
                "schema_version": SCHEMA_VERSION,
                "protocol": PROTOCOL_VERSION,
                "runtime": runtime_ref(),
                "devices": devices(),
                "loaded_models": sorted(sm.models),
                "sessions": len(sm.sessions),
                "kill_switch": self.kill_switch,
            }
        if op == "capabilities":
            d = devices()
            return {
                "workloads": ["infernet.temporal.train", "infernet.temporal.infer"],
                "families": ["cfc", "ltc", "gru"],
                "research_families": ["ltc"],
                "devices": d,
                "ram_mb": ram_mb(),
                "threads": os.cpu_count() or 1,
                "max_sessions": sm.max_sessions,
                "runtime": runtime_ref(),
            }
        if op == "validate":
            bundle = _bundle(p)
            dhash = verify_bundle(bundle)
            return {
                "dataset_hash": dhash,
                "episodes": len(bundle["episodes"]),
                "counts": bundle["manifest"]["splits"]["counts"],
                "tasks": sorted({e["task"] for e in bundle["episodes"]}),
            }
        if op == "load":
            model, manifest = load_model(p["model_dir"], p.get("expected_hash"))
            lm = LoadedModel(model, manifest, float(p.get("abstain_threshold", 0.5)))
            sm.add_model(lm)
            return {"model_hash": lm.hash, "manifest": manifest}
        if op == "manifest":
            return read_manifest(p["model_dir"])
        if op == "unload":
            sm.remove_model(p["model_hash"])
            return {"model_hash": p["model_hash"], "unloaded": True}
        if op == "open_session":
            return sm.open(p["model_hash"], p["session_id"], p.get("ttl_s"), scope)
        if op == "predict":
            return sm.predict(p["request"], scope, self.kill_switch)
        if op == "reset":
            return sm.reset(p["session_id"], scope)
        if op == "close_session":
            return sm.close(p["session_id"], scope)
        if op == "checkpoint":
            return sm.checkpoint(p["session_id"], p["dir"], scope)
        if op == "restore":
            return sm.restore(p["path"], p.get("session_id"), scope)
        if op == "kill_switch":
            self.kill_switch = bool(p.get("on", True))
            return {"kill_switch": self.kill_switch}
        if op == "cancel":
            ev = self.jobs.get(p.get("target"))
            if ev:
                ev.set()
            return {"cancelled": bool(ev)}
        if op == "shutdown":
            self.running = False
            return {"bye": True}
        raise LiquidError("E_BAD_REQUEST", f"unknown op {op}")
