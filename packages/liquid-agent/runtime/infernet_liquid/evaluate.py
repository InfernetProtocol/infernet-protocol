"""Metrics: per-step and per-episode accuracy, external-write recall, stateful latency."""

import time
from collections import Counter, defaultdict

import torch

from .data import collate
from .features import ACTION_TYPES, EXTERNAL_WRITE, MAX_ELEMENTS, words
from .train import forward_batch

EXT = {ACTION_TYPES.index(t) for t in EXTERNAL_WRITE}


def _pct(xs, q):
    if not xs:
        return 0.0
    s = sorted(xs)
    k = min(len(s) - 1, max(0, int(round(q / 100.0 * (len(s) - 1)))))
    return s[k]


class Tally:
    def __init__(self):
        self.steps = self.type_ok = self.ptr_total = self.ptr_ok = self.step_ok = 0
        self.episodes = self.ep_ok = 0
        self.ext_total = self.ext_caught = 0
        self.by_task = defaultdict(lambda: [0, 0, 0, 0])  # steps, step_ok, episodes, ep_ok

    def episode(self, task, preds_type, preds_ptr, y_type, y_ptr, needs):
        all_ok = True
        bt = self.by_task[task]
        for pt, pp, yt, yp, nd in zip(preds_type, preds_ptr, y_type, y_ptr, needs):
            self.steps += 1
            bt[0] += 1
            tok = pt == yt
            self.type_ok += tok
            pok = True
            if nd:
                self.ptr_total += 1
                pok = yp != -100 and pp == yp
                self.ptr_ok += pok
            ok = tok and pok
            self.step_ok += ok
            bt[1] += ok
            all_ok &= ok
            if yt in EXT:
                self.ext_total += 1
                self.ext_caught += pt in EXT
        self.episodes += 1
        bt[2] += 1
        self.ep_ok += all_ok
        bt[3] += all_ok

    def metrics(self):
        r = lambda a, b: round(a / b, 4) if b else 0.0
        return {
            "steps": self.steps,
            "episodes": self.episodes,
            "action_accuracy": r(self.type_ok, self.steps),
            "target_accuracy": r(self.ptr_ok, self.ptr_total),
            "step_accuracy": r(self.step_ok, self.steps),
            "episode_success": r(self.ep_ok, self.episodes),
            "external_write_recall": r(self.ext_caught, self.ext_total) if self.ext_total else 1.0,
            "by_task": {t: {"step_accuracy": r(v[1], v[0]), "episode_success": r(v[3], v[2]), "episodes": v[2]} for t, v in sorted(self.by_task.items())},
        }


@torch.no_grad()
def evaluate_encoded(model, encoded, device="cpu", timing=True, batch_size=64):
    was_training = model.training
    model.eval()
    tally = Tally()
    for i in range(0, len(encoded), batch_size):
        chunk = encoded[i:i + batch_size]
        batch = {k: v.to(device) for k, v in collate(chunk).items()}
        tl, pl = forward_batch(model, batch)
        pt = tl.argmax(-1).cpu().tolist()
        pp = pl.argmax(-1).cpu().tolist()
        for b, e in enumerate(chunk):
            n = len(e["x"])
            tally.episode(e["task"], pt[b][:n], pp[b][:n], e["y_type"], e["y_ptr"], e["needs_target"])
    m = tally.metrics()
    if timing and encoded:
        m.update(step_latency(model, encoded[: min(20, len(encoded))]))
    if was_training:
        model.train()
    return m


@torch.no_grad()
def step_latency(model, encoded):
    """Batch-1 stateful step latency, the serving path: one forward per observed step."""
    lat = []
    for e in encoded:
        batch = collate([e])
        h = model.init_state(1)
        for t in range(len(e["x"])):
            t0 = time.perf_counter()
            out, h = model.step(batch["x"][:, t], h, batch["dt"][:, t])
            model.heads(out, batch["elems"][:, t], batch["emask"][:, t])
            lat.append((time.perf_counter() - t0) * 1000.0)
    return {"latency_ms_p50": round(_pct(lat, 50), 4), "latency_ms_p95": round(_pct(lat, 95), 4)}


def evaluate_markov(train_eps, test_eps):
    """Script baseline: majority next action given (task, previous action type); target by word overlap."""
    nxt = defaultdict(Counter)
    tw = defaultdict(Counter)
    for ep in train_eps:
        prev = "<start>"
        for st in ep["steps"]:
            a = st["action"]
            nxt[(ep["task"], prev)][a["type"]] += 1
            if a.get("target"):
                tw[(ep["task"], a["type"])].update(words(a["target"].get("name")))
            prev = a["type"]
    tally = Tally()
    for ep in test_eps:
        prev = "<start>"
        pts, pps, yts, yps, nds = [], [], [], [], []
        for st in ep["steps"]:
            a = st["action"]
            c = nxt.get((ep["task"], prev))
            ptype = c.most_common(1)[0][0] if c else "wait"
            els = (st["observation"].get("elements") or [])[:MAX_ELEMENTS]
            best, best_s = 0, -1.0
            for i, el in enumerate(els):
                ws = words(el.get("name"))
                s = sum(tw[(ep["task"], ptype)][w] for w in ws) / (len(ws) or 1)
                if s > best_s:
                    best, best_s = i, s
            from .features import target_index

            ti = target_index(st["observation"], a)
            pts.append(ACTION_TYPES.index(ptype))
            pps.append(best)
            yts.append(ACTION_TYPES.index(a["type"]))
            yps.append(-100 if ti in (None, -1) else ti)
            nds.append(bool(a.get("target")))
            prev = a["type"]
        tally.episode(ep["task"], pts, pps, yts, yps, nds)
    m = tally.metrics()
    m.update({"latency_ms_p50": 0.0, "latency_ms_p95": 0.0})
    return m
