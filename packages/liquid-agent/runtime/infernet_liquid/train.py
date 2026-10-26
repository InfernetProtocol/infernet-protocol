"""Training loop: identical splits, seed and budget for every family."""

import random
import time
from datetime import datetime, timezone

import torch
from torch import nn

from .data import collate, encode_episode, split_episodes
from .errors import LiquidError
from .models import TemporalPolicy

DEFAULTS = {
    "hidden_units": 64,
    "epochs": 40,
    "learning_rate": 0.005,
    "batch_size": 16,
    "seed": 0,
    "feature_dim": 256,
    "backbone_units": 64,
    "early_stop_patience": 8,
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def pick_device(want):
    if want in (None, "auto", "cpu"):
        if want == "auto" and torch.cuda.is_available():
            return "cuda"
        return "cpu"
    if want == "cuda" and not torch.cuda.is_available():
        raise LiquidError("E_BAD_REQUEST", "cuda requested but no CUDA device is available")
    if want == "mps" and not (getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()):
        raise LiquidError("E_BAD_REQUEST", "mps requested but not available")
    return want


def forward_batch(model, batch):
    B, T, _ = batch["x"].shape
    h = model.init_state(B).to(batch["x"].device)
    type_logits, ptr_logits = [], []
    for t in range(T):
        out, h_new = model.step(batch["x"][:, t], h, batch["dt"][:, t])
        keep = batch["smask"][:, t].unsqueeze(-1)
        h = torch.where(keep, h_new, h)
        tl, pl = model.heads(out, batch["elems"][:, t], batch["emask"][:, t])
        type_logits.append(tl)
        ptr_logits.append(pl)
    return torch.stack(type_logits, 1), torch.stack(ptr_logits, 1)


def loss_of(type_logits, ptr_logits, batch):
    ce = nn.CrossEntropyLoss(ignore_index=-100)
    lt = ce(type_logits.reshape(-1, type_logits.shape[-1]), batch["y_type"].reshape(-1))
    yp = batch["y_ptr"]
    if (yp != -100).any():
        lp = ce(ptr_logits.reshape(-1, ptr_logits.shape[-1]), yp.reshape(-1))
    else:
        lp = torch.zeros(())
    return lt + lp


def _batches(items, size, rng):
    idx = list(range(len(items)))
    rng.shuffle(idx)
    for i in range(0, len(idx), size):
        yield [items[j] for j in idx[i:i + size]]


def train(bundle, family, hyper=None, device="auto", max_threads=None, on_event=None, cancelled=None, deadline=None):
    """Train one model. Returns (model, info). Raises E_CANCELLED/E_TIMEOUT."""
    from .evaluate import evaluate_encoded

    hp = {**DEFAULTS, **(hyper or {})}
    dev = pick_device(device)
    if max_threads:
        torch.set_num_threads(int(max_threads))
    seed = int(hp["seed"])
    torch.manual_seed(seed)
    rng = random.Random(seed)
    splits = split_episodes(bundle)
    if not splits["train"]:
        raise LiquidError("E_SCHEMA", "dataset has no train episodes")
    enc = {k: [encode_episode(e, hp["feature_dim"]) for e in v] for k, v in splits.items()}
    model = TemporalPolicy(family, hp["feature_dim"], hp["hidden_units"], hp["backbone_units"]).to(dev)
    opt = torch.optim.Adam(model.parameters(), lr=hp["learning_rate"])
    started, t0 = now_iso(), time.monotonic()
    best, best_state, bad = -1.0, None, 0
    val_set = enc["validation"] or enc["train"]
    epochs_run = 0
    for epoch in range(1, hp["epochs"] + 1):
        model.train()
        total, n = 0.0, 0
        for chunk in _batches(enc["train"], hp["batch_size"], rng):
            if cancelled and cancelled():
                raise LiquidError("E_CANCELLED", "training cancelled")
            if deadline and time.monotonic() > deadline:
                raise LiquidError("E_TIMEOUT", "training exceeded its timeout")
            batch = {k: v.to(dev) for k, v in collate(chunk).items()}
            tl, pl = forward_batch(model, batch)
            loss = loss_of(tl, pl, batch)
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total += loss.item() * len(chunk)
            n += len(chunk)
        epochs_run = epoch
        val = evaluate_encoded(model, val_set, device=dev, timing=False)
        if on_event:
            on_event({"event": "epoch", "family": family, "epoch": epoch, "loss": round(total / max(n, 1), 6), "val_step_accuracy": val["step_accuracy"]})
        score = val["step_accuracy"] + 1e-3 * val["episode_success"]
        if score > best + 1e-9:
            best, bad = score, 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        else:
            bad += 1
            if hp["early_stop_patience"] and bad >= hp["early_stop_patience"]:
                break
    if best_state is not None:
        model.load_state_dict(best_state)
    model.to("cpu").eval()
    info = {
        "hyperparameters": hp,
        "device": dev,
        "started_at": started,
        "finished_at": now_iso(),
        "train_seconds": round(time.monotonic() - t0, 3),
        "epochs_run": epochs_run,
        "encoded": enc,
    }
    return model, info
