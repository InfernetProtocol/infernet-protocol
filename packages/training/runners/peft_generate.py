#!/usr/bin/env python3
"""Answer chat messages with a base model plus a LoRA adapter (workload infernet.text.infer).

    python peft_generate.py request.json

request.json:
    {
      "adapter_dir": "adapter",                 local dir: adapter_config.json, adapter_model.safetensors, manifest.json
      "base_model": "HuggingFaceTB/SmolLM2-135M-Instruct",   optional; else the adapter manifest's
      "messages": [{"role": "user", "content": "..."}],      a system message is added from the manifest if absent
      "max_new_tokens": 350,
      "threads": 4
    }

Relative paths resolve against the request file's directory. Local files only.
Prints one JSON object on stdout:
    {"v": 1, "type": "answer", "text": "...", "model": "<base>", "adapter": "sha256:<hex>", "tokens": N, "seconds": S}
or {"v": 1, "type": "error", "message": "..."} and exits 1. Logs go to stderr.
"""

import hashlib
import json
import os
import sys
import time
import traceback
from pathlib import Path


def resolve(base_dir, p):
    p = str(p).removeprefix("file://")
    if "://" in p:
        raise ValueError("adapter_dir must be a local path")
    return Path(p) if os.path.isabs(p) else base_dir / p


def main():
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    req_path = Path(sys.argv[1] if len(sys.argv) > 1 else "request.json").resolve()
    req = json.loads(req_path.read_text())
    adapter = resolve(req_path.parent, req["adapter_dir"])
    manifest = {}
    if (adapter / "manifest.json").exists():
        manifest = json.loads((adapter / "manifest.json").read_text())
    base = req.get("base_model") or manifest.get("base_model")
    if not base:
        raise ValueError("base_model is missing (not in the request or the adapter manifest)")
    weights = adapter / "adapter_model.safetensors"
    digest = "sha256:" + hashlib.sha256(weights.read_bytes()).hexdigest()

    messages = [m for m in req.get("messages") or [] if isinstance(m, dict) and isinstance(m.get("content"), str)]
    if not messages:
        raise ValueError("messages[] is required")
    if messages[0].get("role") != "system" and manifest.get("system_prompt"):
        messages = [{"role": "system", "content": manifest["system_prompt"]}] + messages

    torch.set_num_threads(int(req.get("threads") or min(4, os.cpu_count() or 1)))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    t0 = time.time()
    tok = AutoTokenizer.from_pretrained(adapter if (adapter / "tokenizer_config.json").exists() else base)
    model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.float32).to(device)
    model = PeftModel.from_pretrained(model, adapter).eval()
    prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    ids = tok(prompt, return_tensors="pt").to(device)
    with torch.no_grad():
        # Greedy: sampling on a small model echoes the question and rambles.
        out = model.generate(**ids, max_new_tokens=int(req.get("max_new_tokens") or 350), do_sample=False, repetition_penalty=1.1)
    new = out[0][ids["input_ids"].shape[1]:]
    text = tok.decode(new, skip_special_tokens=True).strip()
    print(json.dumps({"v": 1, "type": "answer", "text": text, "model": base, "adapter": digest,
                      "tokens": int(new.shape[0]), "seconds": round(time.time() - t0, 2)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"v": 1, "type": "error", "message": str(e)}), flush=True)
        sys.exit(1)
