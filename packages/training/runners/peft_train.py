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
      "dataset": { "url": "corpus.jsonl", "sha256": "<hex>"? },   jsonl, see below
      "hyperparams": { "lr", "batch_size", "epochs", "max_steps", "seq_len", "lora_r", "threads", "seed",
                       "dtype" },               float32 | bfloat16 | float16 | auto (default)
      "output": { "destination_url": "out/adapter" }
    }

Dataset records (one JSON object per line, mixing allowed):

    {"title"?: "...", "text": "..."}       one "Brief me on: <title>" exchange,
                                           loss on the whole exchange (as before)
    {"messages": [{"role", "content"}...]} the whole conversation through the
                                           model's chat template, loss on the
                                           assistant turns only; the job's
                                           system prompt is added when the
                                           conversation has none

`dtype` is what the base model's weights load in; the LoRA weights always
train in float32. `auto` picks bfloat16 where the hardware does it natively
(CUDA with bf16, CPUs with avx512_bf16 / amx_bf16 / Arm bf16) and float32
elsewhere: bf16 is several times faster and needs half the RAM on those CPUs,
but emulated bf16 on an older CPU is slower than float32.

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


# Dataset record shapes this runner reads. `infernet model runtime status
# --peft --json` reports them, so callers know what they may send.
DATASET_FORMATS = ("text", "messages")
ROLES = ("system", "user", "assistant")
IGNORE = -100


DTYPES = ("float32", "bfloat16", "float16")
DTYPE_ALIASES = {"fp32": "float32", "bf16": "bfloat16", "fp16": "float16", "half": "float16"}


def cpu_has_bf16(cpuinfo=None):
    """Whether this CPU does bfloat16 natively (x86 avx512_bf16 / amx_bf16, Arm bf16)."""
    if cpuinfo is None:
        try:
            cpuinfo = Path("/proc/cpuinfo").read_text()
        except OSError:
            return False
    flags = set()
    for line in cpuinfo.splitlines():
        key, _, val = line.partition(":")
        if key.strip().lower() in ("flags", "features"):
            flags.update(val.split())
    return bool(flags & {"avx512_bf16", "amx_bf16", "bf16"})


def resolve_dtype(requested, device, cuda_bf16=False, cpu_bf16=False):
    """The dtype name to load the base model in: `hyperparams.dtype` if set,
    else (auto) bfloat16 where it is native and float32 elsewhere."""
    want = DTYPE_ALIASES.get(str(requested or "auto").lower(), str(requested or "auto").lower())
    if want == "auto":
        native = cuda_bf16 if device == "cuda" else cpu_bf16
        return "bfloat16" if native else "float32"
    if want not in DTYPES:
        raise ValueError(f"hyperparams.dtype must be one of {', '.join(DTYPES)} or auto, not {requested!r}")
    return want


def parse_record(d):
    """One dataset line as a doc, or None to skip it. Raises on a malformed
    conversation so a bad dataset fails loudly instead of training on less."""
    msgs = d.get("messages")
    if isinstance(msgs, list) and msgs:
        turns = []
        for m in msgs:
            role = m.get("role") if isinstance(m, dict) else None
            content = m.get("content") if isinstance(m, dict) else None
            if role not in ROLES or not isinstance(content, str):
                raise ValueError("every message needs a role of system, user or assistant and a string content")
            turns.append({"role": role, "content": content})
        if not any(t["role"] == "assistant" and t["content"].strip() for t in turns):
            return None
        return {"messages": turns}
    if d.get("text"):
        return {"title": d.get("title") or "", "text": d["text"]}
    return None


def load_dataset(spec, base_dir):
    # Local files only: the runner never fetches from the network. A remote
    # corpus is downloaded and hash-checked by the caller (c0mpute's text
    # worker) and handed over as a path, so a job cannot point this process at
    # an arbitrary URL.
    url = spec["url"]
    if "://" in url and not url.startswith("file://"):
        raise ValueError("dataset.url must be a local path; download remote corpora first")
    raw = resolve(base_dir, url).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    want = (spec.get("sha256") or "").removeprefix("sha256:")
    if want and digest != want:
        raise ValueError(f"dataset sha256 {digest} differs from the job's {want}")
    docs = []
    for line in raw.decode().splitlines():
        if not line.strip():
            continue
        doc = parse_record(json.loads(line))
        if doc:
            docs.append(doc)
    if len(docs) < 2:
        raise ValueError("dataset needs at least 2 documents with text")
    return docs, digest


def conversation(doc, system):
    """The chat a doc trains as."""
    if "messages" in doc:
        msgs = doc["messages"]
        return msgs if msgs[0]["role"] == "system" else [{"role": "system", "content": system}, *msgs]
    # Each text document becomes one briefing exchange, so the tune keeps the
    # instruct model's chat format instead of drifting into raw prose.
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"Brief me on: {doc['title']}" if doc["title"] else "Brief me."},
        {"role": "assistant", "content": doc["text"]},
    ]


def encode(tok, doc, system):
    """(input_ids, labels) for one doc.

    Text docs learn the whole exchange, as this runner always did.
    Conversations learn only what the assistant says: the template is rendered
    for growing prefixes of the chat, and the tokens each assistant turn adds
    after the generation prompt keep their labels; everything else is IGNORE.
    A template whose prefixes do not nest falls back to learning the whole
    conversation rather than guessing where the turns are."""
    msgs = conversation(doc, system)

    def ids_of(text):
        return tok(text, add_special_tokens=False)["input_ids"]

    if "messages" not in doc:
        ids = ids_of(tok.apply_chat_template(msgs, tokenize=False))
        return ids, list(ids)
    ids, labels, done = [], [], ""
    for k, m in enumerate(msgs):
        full = tok.apply_chat_template(msgs[: k + 1], tokenize=False)
        if m["role"] == "assistant":
            prompt = tok.apply_chat_template(msgs[:k], tokenize=False, add_generation_prompt=True)
        else:
            prompt = full
        if not (prompt.startswith(done) and full.startswith(prompt)):
            ids = ids_of(tok.apply_chat_template(msgs, tokenize=False))
            return ids, list(ids)
        head = ids_of(prompt[len(done):]) if len(prompt) > len(done) else []
        ids += head
        labels += [IGNORE] * len(head)
        if m["role"] == "assistant" and len(full) > len(prompt):
            said = ids_of(full[len(prompt):])
            ids += said
            labels += said
        done = full
    return ids, labels


def pack_ids(encoded, seq_len):
    """Concatenate (ids, labels) pairs into seq_len blocks, dropping any block
    with nothing to learn (all IGNORE), which would give a NaN loss."""
    ids, labels = [], []
    for i, l in encoded:
        ids.extend(i)
        labels.extend(l)
    blocks = []
    for s in range(0, len(ids) - seq_len + 1, seq_len):
        lab = labels[s : s + seq_len]
        if any(x != IGNORE for x in lab):
            blocks.append((ids[s : s + seq_len], lab))
    return blocks


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
    dtype = resolve_dtype(
        hp.get("dtype"), device,
        cuda_bf16=device == "cuda" and torch.cuda.is_bf16_supported(),
        cpu_bf16=cpu_has_bf16(),
    )
    hp["dtype"] = dtype
    if dtype == "float16" and device == "cpu":
        log("warning: float16 on CPU is slow and can overflow; bfloat16 or float32 is the better choice")

    random.seed(hp["seed"])
    torch.manual_seed(hp["seed"])
    torch.set_num_threads(int(hp["threads"]))

    def pack(tok, docs, seq_len):
        # (input_ids, labels), each [blocks, seq_len].
        blocks = pack_ids([encode(tok, d, system) for d in docs], seq_len)
        return (
            torch.tensor([b[0] for b in blocks], dtype=torch.long).reshape(-1, seq_len),
            torch.tensor([b[1] for b in blocks], dtype=torch.long).reshape(-1, seq_len),
        )

    @torch.no_grad()
    def perplexity(model, blocks, batch_size):
        ids, labels = blocks
        model.eval()
        losses = [
            model(input_ids=ids[i : i + batch_size].to(device), labels=labels[i : i + batch_size].to(device)).loss.item()
            for i in range(0, len(ids), batch_size)
        ]
        model.train()
        return math.exp(sum(losses) / max(len(losses), 1))

    docs, dataset_sha = load_dataset(job["dataset"], base_dir)
    random.shuffle(docs)
    held = max(1, len(docs) // 20)
    tok = AutoTokenizer.from_pretrained(job["base_model"])
    train_blocks = pack(tok, docs[held:], int(hp["seq_len"]))
    eval_blocks = pack(tok, docs[:held], int(hp["seq_len"]))
    if len(train_blocks[0]) == 0:
        raise ValueError("dataset too small for one training block; lower seq_len or add documents")
    steps_per_epoch = math.ceil(len(train_blocks[0]) / int(hp["batch_size"]))
    total = int(hp["max_steps"] or steps_per_epoch * int(hp["epochs"]))

    emit(job_id, "meta", started_at=now(), backend="peft", world_size=1, kind=job.get("kind", "lora"),
         base_model=job["base_model"], device=device, dtype=dtype, total_steps=total, documents=len(docs),
         dataset_sha256=dataset_sha)
    log(f"{len(docs)} docs -> {len(train_blocks[0])} train / {len(eval_blocks[0])} eval blocks of {hp['seq_len']} tokens; {total} steps on {device} in {dtype}")

    model = AutoModelForCausalLM.from_pretrained(job["base_model"], dtype=getattr(torch, dtype)).to(device)
    # Recompute activations in the backward pass: roughly halves peak RAM, so
    # the job fits beside other work on a shared box.
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(
        r=int(hp["lora_r"]), lora_alpha=int(hp["lora_r"]) * 2, lora_dropout=0.05,
        target_modules=hp.get("target_modules") or ["q_proj", "k_proj", "v_proj", "o_proj"],
        task_type="CAUSAL_LM",
    ))
    # The adapter trains in float32 whatever the base is in: bf16 optimizer
    # updates on small LoRA weights lose most of their precision.
    for p in model.parameters():
        if p.requires_grad and p.dtype != torch.float32:
            p.data = p.data.float()
    log(f"trainable params: {sum(p.numel() for p in model.parameters() if p.requires_grad):,}")

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=float(hp["lr"]))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 10) * max(0.0, 1 - s / total))

    if len(eval_blocks[0]):
        emit(job_id, "eval", step=0, metrics={"perplexity": perplexity(model, eval_blocks, int(hp["batch_size"]))})

    step, t0 = 0, time.time()
    model.train()
    while step < total:
        order = torch.randperm(len(train_blocks[0]))
        for i in range(0, len(order), int(hp["batch_size"])):
            pick = order[i : i + int(hp["batch_size"])]
            loss = model(input_ids=train_blocks[0][pick].to(device), labels=train_blocks[1][pick].to(device)).loss
            loss.backward()
            grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0).item()
            opt.step(); sched.step(); opt.zero_grad()
            step += 1
            emit(job_id, "step", step=step, total_steps=total, loss=round(loss.item(), 4), lr=sched.get_last_lr()[0],
                 grad_norm=round(grad_norm, 3),
                 throughput=round(step * int(hp["batch_size"]) * int(hp["seq_len"]) / (time.time() - t0), 1))
            if step >= total:
                break

    if len(eval_blocks[0]):
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
        "conversations": sum(1 for d in docs if "messages" in d),
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
