#!/usr/bin/env python3
"""LoRA-tune a causal language model from a job file, on CPU (or CUDA if present).

    python peft_train.py job.json

The runner for @infernetprotocol/training's `peft` backend (workload
infernet.text.train). `job.json` is that package's job config:

    {
      "id": "...",                      optional
      "name": "business-strategist-agent",
      "kind": "lora",
      "base_model": "HuggingFaceTB/SmolLM2-135M-Instruct",
      "system_prompt": "You are ...",   optional
      "dataset": { "url": "corpus.jsonl", "sha256": "<hex>"? },   jsonl of {title, text}
      "hyperparams": { "lr", "batch_size", "epochs", "max_steps", "seq_len", "lora_r", "threads", "seed" },
      "output": { "destination_url": "out/adapter" }
    }

Relative paths resolve against the job file's directory. Progress goes to
stdout as training-protocol v1 NDJSON (meta / step / eval / checkpoint /
done / error); human-readable logs go to stderr. The output dir holds a PEFT
adapter (adapter_model.safetensors + adapter_config.json), the tokenizer and
manifest.json; the checkpoint event's `model` is sha256 of the adapter weights.
"""

import hashlib
import json
import math
import os
import random
import sys
import time
import traceback
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_SYSTEM = (
    "You are a concise, practical assistant grounded in what independent writers are publishing."
)


def now():
    return datetime.now(timezone.utc).isoformat()


def emit(job_id, type_, **fields):
    print(json.dumps({"v": 1, "type": type_, "id": job_id, **fields}), flush=True)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def resolve(base_dir, p):
    p = p.removeprefix("file://")
    return Path(p) if os.path.isabs(p) else base_dir / p


def load_dataset(spec, base_dir):
    url = spec["url"]
    if url.startswith(("http://", "https://")):
        raw = urllib.request.urlopen(url, timeout=300).read()
    else:
        raw = resolve(base_dir, url).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    want = (spec.get("sha256") or "").removeprefix("sha256:")
    if want and digest != want:
        raise ValueError(f"dataset sha256 {digest} differs from the job's {want}")
    docs = []
    for line in raw.decode().splitlines():
        if not line.strip():
            continue
        d = json.loads(line)
        if d.get("text"):
            docs.append({"title": d.get("title") or "", "text": d["text"]})
    if len(docs) < 2:
        raise ValueError("dataset needs at least 2 documents with text")
    return docs, digest


def main():
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    job_path = Path(sys.argv[1] if len(sys.argv) > 1 else "job.json").resolve()
    job = json.loads(job_path.read_text())
    base_dir = job_path.parent
    job_id = job.get("id") or str(uuid.uuid4())
    hp = {
        "lr": 2e-4, "batch_size": 4, "epochs": 1, "max_steps": None,
        "seq_len": 256, "lora_r": 8, "threads": min(4, os.cpu_count() or 1), "seed": 0,
        **(job.get("hyperparams") or {}),
    }
    system = job.get("system_prompt") or DEFAULT_SYSTEM
    out_dir = resolve(base_dir, job["output"]["destination_url"])
    device = "cuda" if torch.cuda.is_available() else "cpu"

    random.seed(hp["seed"])
    torch.manual_seed(hp["seed"])
    torch.set_num_threads(int(hp["threads"]))

    def to_chat(tok, doc):
        # Each document becomes one briefing exchange, so the tune keeps the
        # instruct model's chat format instead of drifting into raw prose.
        return tok.apply_chat_template(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": f"Brief me on: {doc['title']}" if doc["title"] else "Brief me."},
                {"role": "assistant", "content": doc["text"]},
            ],
            tokenize=False,
        )

    def pack(tok, docs, seq_len):
        ids = []
        for d in docs:
            ids.extend(tok(to_chat(tok, d), add_special_tokens=False)["input_ids"])
        blocks = [ids[i : i + seq_len] for i in range(0, len(ids) - seq_len + 1, seq_len)]
        return torch.tensor(blocks, dtype=torch.long)

    @torch.no_grad()
    def perplexity(model, blocks, batch_size):
        model.eval()
        losses = [
            model(input_ids=blocks[i : i + batch_size].to(device), labels=blocks[i : i + batch_size].to(device)).loss.item()
            for i in range(0, len(blocks), batch_size)
        ]
        model.train()
        return math.exp(sum(losses) / max(len(losses), 1))

    docs, dataset_sha = load_dataset(job["dataset"], base_dir)
    random.shuffle(docs)
    held = max(1, len(docs) // 20)
    tok = AutoTokenizer.from_pretrained(job["base_model"])
    train_blocks = pack(tok, docs[held:], int(hp["seq_len"]))
    eval_blocks = pack(tok, docs[:held], int(hp["seq_len"]))
    if len(train_blocks) == 0:
        raise ValueError("dataset too small for one training block; lower seq_len or add documents")
    steps_per_epoch = math.ceil(len(train_blocks) / int(hp["batch_size"]))
    total = int(hp["max_steps"] or steps_per_epoch * int(hp["epochs"]))

    emit(job_id, "meta", started_at=now(), backend="peft", world_size=1, kind=job.get("kind", "lora"),
         base_model=job["base_model"], device=device, total_steps=total, documents=len(docs),
         dataset_sha256=dataset_sha)
    log(f"{len(docs)} docs -> {len(train_blocks)} train / {len(eval_blocks)} eval blocks of {hp['seq_len']} tokens; {total} steps on {device}")

    model = AutoModelForCausalLM.from_pretrained(job["base_model"], dtype=torch.float32).to(device)
    # Recompute activations in the backward pass: roughly halves peak RAM, so
    # the job fits beside other work on a shared box.
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(
        r=int(hp["lora_r"]), lora_alpha=int(hp["lora_r"]) * 2, lora_dropout=0.05,
        target_modules=hp.get("target_modules") or ["q_proj", "k_proj", "v_proj", "o_proj"],
        task_type="CAUSAL_LM",
    ))
    log(f"trainable params: {sum(p.numel() for p in model.parameters() if p.requires_grad):,}")

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=float(hp["lr"]))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 10) * max(0.0, 1 - s / total))

    if len(eval_blocks):
        emit(job_id, "eval", step=0, metrics={"perplexity": perplexity(model, eval_blocks, int(hp["batch_size"]))})

    step, t0 = 0, time.time()
    model.train()
    while step < total:
        order = torch.randperm(len(train_blocks))
        for i in range(0, len(order), int(hp["batch_size"])):
            batch = train_blocks[order[i : i + int(hp["batch_size"])]].to(device)
            loss = model(input_ids=batch, labels=batch).loss
            loss.backward()
            grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0).item()
            opt.step(); sched.step(); opt.zero_grad()
            step += 1
            emit(job_id, "step", step=step, total_steps=total, loss=round(loss.item(), 4), lr=sched.get_last_lr()[0],
                 grad_norm=round(grad_norm, 3),
                 throughput=round(step * int(hp["batch_size"]) * int(hp["seq_len"]) / (time.time() - t0), 1))
            if step >= total:
                break

    if len(eval_blocks):
        emit(job_id, "eval", step=step, metrics={"perplexity": perplexity(model, eval_blocks, int(hp["batch_size"]))})

    out_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out_dir)
    tok.save_pretrained(out_dir)
    weights = out_dir / "adapter_model.safetensors"
    digest = hashlib.sha256(weights.read_bytes()).hexdigest()
    (out_dir / "manifest.json").write_text(json.dumps({
        "name": job.get("name") or "adapter",
        "kind": job.get("kind", "lora"),
        "base_model": job["base_model"],
        "adapter_sha256": digest,
        "dataset_sha256": dataset_sha,
        "documents": len(docs),
        "steps": step,
        "system_prompt": system,
        "hyperparams": hp,
        "finished_at": now(),
    }, indent=2) + "\n")
    emit(job_id, "checkpoint", step=step, path=str(out_dir), size_bytes=weights.stat().st_size,
         model=f"sha256:{digest}")
    emit(job_id, "done", reason="complete", final_step=step, finished_at=now())


if __name__ == "__main__":
    job_id = "unknown"
    try:
        main()
    except Exception as e:  # report as protocol events so callers never parse a traceback
        traceback.print_exc(file=sys.stderr)
        emit(job_id, "error", message=str(e), code="E_RUNTIME")
        emit(job_id, "done", reason="error", finished_at=now())
        sys.exit(1)
