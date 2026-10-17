# End-to-end training pipeline

Walk through training a custom model from a search query to a published
artifact on both HuggingFace and Ollama. We'll mirror the
[ollama.com/rockypod/svelte-coder](https://ollama.com/rockypod/svelte-coder)
shape — fine-tune a coder on Svelte docs, ship as a one-line `ollama pull`.

## The four steps

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  infernet train  │ →  │  infernet train  │ →  │  infernet train  │ →  │  infernet publish│
│  data            │    │  init            │    │  run             │    │                  │
│  (crawl)         │    │  (config)        │    │  (fine-tune)     │    │  (HF + Ollama)   │
└──────────────────┘    └──────────────────┘    └──────────────────┘    └──────────────────┘
   web → JSONL          JSONL → train.yml          → trained model        → ollama.com URL
```

## 1. Crawl training data from a search query

```bash
infernet train data \
    --query "svelte 5 framework documentation" \
    --domains svelte.dev,kit.svelte.dev,github.com \
    --num 30 \
    --out ./data/svelte5.jsonl
```

This calls `POST /api/v1/search` on the Infernet control plane, which
proxies to a search provider and returns the top 30 Google results,
optionally filtered to a domain whitelist. The CLI then fetches each
URL, extracts the readable text, and chunks it into ChatML-format JSONL:

```json
{"messages":[{"role":"system","content":"You are an expert..."},
             {"role":"user","content":"svelte 5 framework documentation — section 1"},
             {"role":"assistant","content":"Svelte 5 introduces runes — the primary..."}],
 "meta":{"source_url":"https://svelte.dev/docs/svelte/runes","paragraph_index":0}}
```

Auth is the same Nostr keypair the daemon already uses (`infernet init`);
no extra credential is needed. Each pubkey gets a daily search quota
(default 50 queries / 24h). When the quota is exhausted the CLI surfaces
a `429` with the exact reset time.

**Self-hosters** who want to bypass the control plane can pass `--direct`
with a `VALUESERP_API_KEY` set in env (or under
`integrations.valueserp.api_key` in `~/.config/infernet/config.json`).

The crawler will skip paragraphs shorter than `--min-chars` (default 200)
and truncate paragraphs longer than `--max-chars` (default 4000) so each
training sample fits comfortably in a 4K context.

## 2. Scaffold a training config

```bash
infernet train init --output ./run
```

Edit the generated `run/infernet.train.yml`:

```yaml
name: svelte5-coder
base_model: qwen2.5-coder:7b     # 7B coder is plenty for a domain-specific tune
method: qlora                    # 4-bit LoRA; trains on a single 24GB GPU
runtime: unsloth                 # fastest on consumer hardware

input:
  dataset: ./data/svelte5.jsonl  # what we just generated
  format: chatml
  validation_split: 0.1

training:
  epochs: 3
  learning_rate: 2.0e-4
  batch_size: 4
  gradient_accumulation_steps: 4
  max_seq_len: 4096

lora:
  rank: 16
  alpha: 32
  target_modules: [q_proj, v_proj, k_proj, o_proj]

resources:
  min_vram_gb: 24
  max_runtime_hours: 4
```

## 3. Run the fine-tune

```bash
# Local training on this box (single GPU)
infernet train run --local --config ./run/infernet.train.yml

# Or submit to the P2P network (when workload_class: C1+ is set)
infernet train run --config ./run/infernet.train.yml
```

Local mode shells out to the `runtime:` you specified (Unsloth, TRL,
Axolotl, or the bundled microgpt for tiny demos) and writes:

```
run/
├── infernet.train.yml      (frozen copy of the config used)
├── metrics.jsonl           (one line per logging step)
├── README.md               (auto-generated — what was trained, when)
└── checkpoint-final/       (HF-shape directory: config.json + safetensors)
```

## 4. Publish

```bash
infernet publish ./run/checkpoint-final \
    --hf InfernetProtocol/svelte5-coder \
    --ollama infernet/svelte5-coder \
    --quant q4_k_m
```

What this does:

1. **HuggingFace push** — uploads the safetensors directory to
   `huggingface.co/InfernetProtocol/svelte5-coder`. Needs
   `HUGGINGFACE_TOKEN` with write scope on the org.
2. **GGUF convert** — runs `convert_hf_to_gguf.py` from your local
   `llama.cpp` checkout (`~/llama.cpp` by default; override with
   `--llama-cpp-path`). Emits `model.f16.gguf` then quantizes to
   `model.q4_k_m.gguf`.
3. **Modelfile generation** — writes a `Modelfile` with the ChatML
   template and sane defaults (`temperature=0.7`, `top_p=0.9`).
4. **Ollama push** — `ollama create` + `ollama push` so it lands at
   `ollama.com/infernet/svelte5-coder`.
   Run `ollama signin` once before the first publish.

After this, anyone with Ollama can pull your model:

```bash
ollama pull infernet/svelte5-coder
ollama run infernet/svelte5-coder "How do runes work in Svelte 5?"
```

## Variants

- **Just the data**: `infernet train data --query …` and stop. The JSONL
  is portable to any HF/Unsloth/Axolotl/TRL pipeline.
- **Just the publish**: `infernet publish <dir> --modelfile-only` to
  generate the Modelfile + GGUF locally without pushing anywhere.
- **HF only**: `--skip-ollama`. Or **Ollama only**: `--skip-hf`.

## Open-market training (IPIP-0030)

Beyond running on your own GPU, you can post a training job to the
open network: any opted-in operator anywhere claims shards and trains
for pay. Your own daemon hosts the dataset directly — no S3, no HF
dataset, no IPFS, no third-party storage.

```bash
infernet train run --open-market \
    --config ./run/infernet.train.yml \
    --budget 5.00 \
    --max-nodes 8
```

The wire shape:

```
submitter (you)                    control plane                operators (anywhere)
~/.infernet/training-runs/<id>/         │                              │
    shards/shard-0.jsonl  ◀──────  GET /v1/training/shards/<id>/shard-0.jsonl  ◀───
    adapters/             ◀──────  PUT /v1/training/adapters/<id>/0?token=t   ◀───
    manifest.json (upload_token)        │                              │
                                        │                              │
   POST /api/v1/training/jobs    ─────▶ │                              │
   { dataset_base_url:                  │                              │
       <your-daemon-url>/v1/...,        │                              │
     upload_base_url:                   │                              │
       <your-daemon-url>/...?token=t }  │                              │
                                        │                              │
                                        │  POST /shards/available  ◀───│
                                        │  POST /shards/<id>/claim ◀───│
                                        │  POST /shards/<id>/report ◀──│
```

Operators opt in by setting `INFERNET_ACCEPT_TRAINING=1` (or
`engine.acceptTraining: true` in their config). Their daemon polls the
market every 60 seconds; on a successful claim it runs the same Unsloth
runner used by `--local`, then PUTs the LoRA adapter back to your
daemon. Adapters land in `~/.infernet/training-runs/<run_id>/adapters/`.

When all shards report, FedAvg the adapters:

```bash
python3 ./run/_fedavg.py --out ./run/checkpoint-final \
    ~/.infernet/training-runs/<run_id>/adapters/*
```

Then publish (Track 4 above). End-to-end, you've trained a model using
GPUs from operators across the world without spinning up any cloud
infrastructure or paying for storage.

### Behind NAT?

If your daemon's port 8080 isn't reachable from the public internet,
expose it via cloudflared:

```bash
cloudflared tunnel --url http://localhost:8080    # prints a public URL
export INFERNET_DAEMON_ENDPOINT=https://<the-cloudflared-url>
infernet train run --open-market ...
```

The control plane only sees URLs — never your dataset bytes.

## Prerequisites

- A Nostr keypair (`infernet init`) — used to auth against `POST /api/v1/search`
  for the data-crawl step. The platform supplies the upstream search key.
  Self-hosters can override with `VALUESERP_API_KEY` + `--direct`.
- `HUGGINGFACE_TOKEN` with write scope on your target org
- `ollama signin` already done
- `llama.cpp` cloned + built at `$HOME/llama.cpp` for the GGUF convert
- A GPU with enough VRAM for the chosen base model — see
  `infernet model info hf:Qwen/Qwen2.5-Coder-7B-Instruct` for fit estimates
