"""Stateful inference sessions: one hidden state per session, strict sequence order, TTL, checkpoints."""

import json
import math
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

from . import SCHEMA_VERSION
from .canonical import file_sha256, hash_canonical
from .data import collate
from .errors import LiquidError
from .features import ACTION_TYPES, EXTERNAL_WRITE, MAX_ELEMENTS, TARGETED, encode_element, encode_step
from .schema import validate

SESSION_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class LoadedModel:
    def __init__(self, model, manifest, abstain_threshold=0.5):
        self.model = model
        self.manifest = manifest
        self.hash = manifest["weights"]["weights_hash"]
        self.abstain_threshold = abstain_threshold
        self.lock = threading.Lock()


class Session:
    def __init__(self, sid, lm, ttl_s, account_scope, worker, now):
        self.id = sid
        self.lm = lm
        self.ttl_s = ttl_s
        self.account_scope = account_scope
        self.worker = worker
        self.created = now
        self.touched = now
        self.seq = -1
        self.h = lm.model.init_state(1)
        self.state = "active"
        self.checkpoint_ref = None

    def expires(self):
        return self.touched + self.ttl_s

    def to_json(self):
        d = {
            "schema_version": SCHEMA_VERSION,
            "kind": "inference_session",
            "session_id": self.id,
            "model_hash": self.lm.hash,
            "created_at": iso(self.created),
            "expires_at": iso(self.expires()),
            "ttl_s": self.ttl_s,
            "sequence_index": self.seq,
            "state": self.state,
            "checkpoint_ref": self.checkpoint_ref,
            "worker": self.worker,
        }
        if self.account_scope:
            d["account_scope"] = self.account_scope
        return d


class SessionManager:
    def __init__(self, max_sessions=64, default_ttl_s=600, worker="local", clock=time.time):
        self.max_sessions = max_sessions
        self.default_ttl_s = default_ttl_s
        self.worker = worker
        self.clock = clock
        self.models = {}
        self.sessions = {}
        self.lock = threading.RLock()

    # models ---------------------------------------------------------------
    def add_model(self, lm):
        with self.lock:
            self.models[lm.hash] = lm

    def remove_model(self, model_hash):
        with self.lock:
            if model_hash not in self.models:
                raise LiquidError("E_NOT_LOADED", f"model {model_hash} is not loaded")
            for sid in [s for s, v in self.sessions.items() if v.lm.hash == model_hash]:
                self.sessions.pop(sid).state = "closed"
            del self.models[model_hash]

    def model(self, model_hash):
        lm = self.models.get(model_hash)
        if lm is None:
            raise LiquidError("E_NOT_LOADED", f"model {model_hash} is not loaded")
        return lm

    # sessions -------------------------------------------------------------
    def sweep(self):
        now = self.clock()
        for sid in [s for s, v in self.sessions.items() if v.expires() <= now]:
            self.sessions.pop(sid).state = "expired"

    def open(self, model_hash, session_id, ttl_s=None, account_scope=None):
        if not isinstance(session_id, str) or not SESSION_ID.match(session_id):
            raise LiquidError("E_BAD_REQUEST", "session_id must match ^[A-Za-z0-9_.:-]{1,128}$")
        ttl = int(ttl_s or self.default_ttl_s)
        if not 1 <= ttl <= 86400:
            raise LiquidError("E_BAD_REQUEST", "ttl_s must be 1..86400")
        with self.lock:
            self.sweep()
            lm = self.model(model_hash)
            if session_id in self.sessions:
                raise LiquidError("E_BAD_REQUEST", f"session {session_id} already exists; reset or close it")
            if len(self.sessions) >= self.max_sessions:
                raise LiquidError("E_CAPACITY", f"session limit {self.max_sessions} reached")
            s = Session(session_id, lm, ttl, account_scope, self.worker, self.clock())
            self.sessions[session_id] = s
            return s.to_json()

    def get(self, session_id, account_scope=None):
        with self.lock:
            s = self.sessions.get(session_id)
            if s is not None and s.expires() <= self.clock():
                self.sessions.pop(session_id)
                raise LiquidError("E_SESSION_EXPIRED", f"session {session_id} expired; open a new one or restore a checkpoint")
            if s is None:
                raise LiquidError("E_SESSION_UNKNOWN", f"no session {session_id}")
            if s.account_scope and account_scope and s.account_scope != account_scope:
                raise LiquidError("E_SESSION_UNKNOWN", f"no session {session_id} in this account scope")
            return s

    def reset(self, session_id, account_scope=None):
        s = self.get(session_id, account_scope)
        with s.lm.lock:
            s.h = s.lm.model.init_state(1)
            s.seq = -1
            s.touched = self.clock()
            s.checkpoint_ref = None
        return s.to_json()

    def close(self, session_id, account_scope=None):
        s = self.get(session_id, account_scope)
        with self.lock:
            self.sessions.pop(session_id, None)
        s.state = "closed"
        return s.to_json()

    def predict(self, req, account_scope=None, kill_switch=False):
        errors = validate(req, "predict_request")
        if errors:
            raise LiquidError("E_SCHEMA", "predict request failed validation: " + "; ".join(f"{a or '/'} {b}" for a, b in errors[:5]))
        s = self.get(req["session_id"], account_scope)
        lm = s.lm
        if req.get("model_hash") and req["model_hash"] != lm.hash:
            raise LiquidError("E_MODEL_HASH", f"session {s.id} serves {lm.hash}, request names {req['model_hash']}")
        idx = req["sequence_index"]
        with lm.lock:
            if idx == s.seq:
                raise LiquidError("E_SEQ_DUPLICATE", f"sequence_index {idx} already processed", expected=s.seq + 1)
            if idx < s.seq:
                raise LiquidError("E_SEQ_LATE", f"sequence_index {idx} is older than the last accepted {s.seq}", expected=s.seq + 1)
            if idx > s.seq + 1:
                raise LiquidError("E_SEQ_GAP", f"sequence_index {idx} skips {s.seq + 1}; the state cannot skip steps", expected=s.seq + 1)
            t0 = time.perf_counter()
            proposal = self._step(s, req)
            s.seq = idx
            s.touched = self.clock()
            proposal["latency_ms"] = round((time.perf_counter() - t0) * 1000.0, 4)
        if kill_switch:
            proposal.update({"action": None, "alternatives": [], "requires_approval": False, "abstain_reason": "kill_switch"})
        return proposal

    @torch.no_grad()
    def _step(self, s, req):
        m = s.lm.model
        F = m.feature_dim
        obs = req["observation"]
        x = torch.tensor([encode_step(req.get("task"), obs, req.get("prev_action"), req["dt_ms"], F)])
        dt = torch.tensor([[min(req["dt_ms"] / 1000.0, 60.0)]])
        els = (obs.get("elements") or [])[:MAX_ELEMENTS]
        enc = collate([{
            "x": [[0.0] * F], "dt": [[0.0]], "elems": [[encode_element(e, i) for i, e in enumerate(els)]],
            "n_elems": [len(els)], "y_type": [0], "y_ptr": [-100], "needs_target": [False],
        }])
        out, s.h = m.step(x, s.h, dt)
        tl, pl = m.heads(out, enc["elems"][:, 0], enc["emask"][:, 0])
        p_type = torch.softmax(tl[0], -1)
        p_ptr = torch.softmax(pl[0], -1) if els else None
        ent = float(-(p_type * torch.log(p_type.clamp_min(1e-12))).sum()) / math.log(len(ACTION_TYPES))
        cands = []
        for ti in torch.topk(p_type, k=3).indices.tolist():
            t = ACTION_TYPES[ti]
            if t in TARGETED:
                if p_ptr is None:
                    continue
                for ei in torch.topk(p_ptr, k=min(2, len(els))).indices.tolist():
                    el = els[ei]
                    target = {k: el[k] for k in ("role", "name", "id") if k in el}
                    cands.append(({"type": t, "target": target}, float(p_type[ti] * p_ptr[ei])))
            else:
                cands.append(({"type": t}, float(p_type[ti])))
        cands.sort(key=lambda c: -c[1])
        best_type = ACTION_TYPES[int(p_type.argmax())]
        action, conf, reason = None, 0.0, None
        if best_type in TARGETED and p_ptr is None:
            reason = "unknown_target"
            conf = float(p_type.max())
        elif cands:
            action, conf = cands[0]
            if conf < s.lm.abstain_threshold:
                reason = "low_confidence"
        if reason:
            action = None
        return {
            "schema_version": SCHEMA_VERSION,
            "kind": "action_proposal",
            "session_id": s.id,
            "sequence_index": req["sequence_index"],
            "model_hash": s.lm.hash,
            "action": action,
            "confidence": round(min(1.0, max(0.0, conf)), 6),
            "uncertainty": round(min(1.0, max(0.0, ent)), 6),
            "alternatives": [{"action": a, "p": round(min(1.0, p), 6)} for a, p in cands[1:4]],
            "requires_approval": bool(action and action["type"] in EXTERNAL_WRITE),
            "abstain_reason": reason,
        }

    # checkpoints ----------------------------------------------------------
    def checkpoint(self, session_id, directory, account_scope=None):
        s = self.get(session_id, account_scope)
        d = Path(directory)
        d.mkdir(parents=True, exist_ok=True)
        with s.lm.lock:
            state_path = d / f"{session_id}.state.safetensors"
            save_file({"h": s.h.contiguous().clone()}, str(state_path))
            meta = {
                "schema_version": SCHEMA_VERSION,
                "session_id": s.id,
                "model_hash": s.lm.hash,
                "sequence_index": s.seq,
                "ttl_s": s.ttl_s,
                "account_scope": s.account_scope,
                "state_hash": file_sha256(state_path),
            }
            ref = hash_canonical(meta)
            (d / f"{session_id}.checkpoint.json").write_text(json.dumps({**meta, "checkpoint_ref": ref}, indent=2, sort_keys=True), "utf-8")
            s.checkpoint_ref = ref
        return {"checkpoint_ref": ref, "path": str(d / f"{session_id}.checkpoint.json"), "session": s.to_json()}

    def restore(self, path, session_id=None, account_scope=None):
        p = Path(path)
        try:
            meta = json.loads(p.read_text("utf-8"))
        except (OSError, ValueError) as e:
            raise LiquidError("E_BAD_REQUEST", f"cannot read checkpoint {path}: {e}")
        ref = meta.pop("checkpoint_ref", None)
        if hash_canonical(meta) != ref:
            raise LiquidError("E_HASH_MISMATCH", "checkpoint_ref does not match the checkpoint")
        state_path = p.with_name(f"{meta['session_id']}.state.safetensors")
        if file_sha256(state_path) != meta["state_hash"]:
            raise LiquidError("E_HASH_MISMATCH", "checkpoint state does not match its hash")
        if meta.get("account_scope") and account_scope and meta["account_scope"] != account_scope:
            raise LiquidError("E_SESSION_UNKNOWN", "checkpoint belongs to another account scope")
        sid = session_id or meta["session_id"]
        with self.lock:
            lm = self.model(meta["model_hash"])
            if sid in self.sessions:
                self.sessions.pop(sid)
            self.open(lm.hash, sid, meta["ttl_s"], meta.get("account_scope"))
            s = self.sessions[sid]
            s.h = load_file(str(state_path))["h"]
            s.seq = meta["sequence_index"]
            s.checkpoint_ref = ref
            return s.to_json()
