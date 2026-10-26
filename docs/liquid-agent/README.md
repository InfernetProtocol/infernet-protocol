# Liquid Agent: Infernet temporal-policy family

Status: phase 0 (audit + contracts) and phase 1 (local vertical slice) shipped; phase 2 network execution lands through c0mpute (see "c0mpute" below).
PRDs: [umbrella](PRD-UNIFIED-LIQUID-AGENT-PIPELINE.md), [Infernet runtime on c0mpute](PRD-INFERNET-C0MPUTE-LIQUID-RUNTIME.md), [W3BS Training](PRD-W3BS-DESKTOP-TRAINING-LIQUID-AGENT.md).
Benchmark: [benchmark.md](benchmark.md) (CfC vs GRU vs LTC vs a script baseline).

## Phase 0 audit: what existed

| Surface | What is there | How temporal policies fit |
|---|---|---|
| `@infernetprotocol/engine` | NDJSON-over-stdio protocol v1 for LLM engines (`load`/`generate`/`token`/`done`), backends ollama, vllm, sglang, llamacpp, mojo, stub | Untouched. LLM serving is not a CfC/LTC runtime; nothing here assumes GGUF can hold a liquid network. |
| `@infernetprotocol/training` | Training IPC protocol v1 (`meta`/`step`/`eval`/`checkpoint`/`done`), backends deepspeed, openrlhf, opendiloco, petals (placeholders) and stub | New `liquid` backend speaks this protocol; job kind `temporal-policy` added. |
| `infernet train` | microgpt / unsloth fine-tunes, P2P `train_shard` LoRA shards | Untouched: LLM fine-tuning, a different family. |
| Daemon command verbs | `model_install`, `model_remove`, `train_shard` via the control plane | Not used for temporal jobs; network dispatch goes through c0mpute's job/receipt protocol per the PRD. |
| `infernet model` | Ollama / HF model lifecycle | Gains `train`, `evaluate`, `predict`, `serve`, `capabilities`, `runtime`, `synth` for the temporal family. |

## Layout

- `packages/liquid-agent/schemas/`: liquid-agent/v1 JSON Schemas: `EpisodeV1`, `DatasetManifestV1`, `DatasetBundleV1`, `TrainJobV1`, `ModelManifestV1`, `InferenceSessionV1`, `PredictRequestV1`, `ActionProposalV1` (+ `common`).
- `packages/liquid-agent/fixtures/`: valid and invalid fixtures, and `contract.json` pinning the schema-bundle hash and two content hashes. W3BS and c0mpute vendor the schemas and check this hash.
- `packages/liquid-agent/src/`: canonical JSON + sha256 content hashes, a dependency-free validator for the schema subset, the secret scan, dataset bundle builder/verifier, and the runtime client. No Python anywhere in Node's import graph.
- `packages/liquid-agent/runtime/`: `infernet-liquid`, Python 3.11+, PyTorch + ncps, pinned by `requirements.lock` (CPU, hash-checked) and `requirements-cuda.lock`.

## Contract rules

- Every object carries `schema_version: "liquid-agent/v1"` and a `kind`.
- Content hashes are `sha256:` over canonical JSON (sorted keys, no whitespace, JS number formatting). Python and JS produce identical bytes; `contract.json` was hashed in Python and the JS tests check it, and the other way round.
- `EpisodeV1.content_hash` covers the episode without itself. `DatasetManifestV1.dataset_hash` covers `{episodes, splits}`. The model hash is `ModelManifestV1.weights.weights_hash`, the sha256 of the safetensors file; `manifest_hash` covers the manifest minus itself and `signature`.
- Splits are assigned per `split_group` (recording session, account or variant) from a seed, so a group never straddles train and test.
- Workload ids: `infernet.temporal.train`, `infernet.temporal.infer`. Families: `cfc`, `ltc` (research), `gru` (baseline).

## Runtime contract (stdio NDJSON, protocol 1)

`{"v":1,"id":"r1","op":...}` in, `{"v":1,"id":"r1","ok":true,"result":...}` or `{"ok":false,"error":{"code","message","retriable"}}` out; train/evaluate stream `{"id","event":"epoch",...}`.

| PRD adapter op | Runtime op |
|---|---|
| health / capabilities | `health`, `capabilities` |
| validate | `validate` (schema, every hash, manifest agreement, secret scan) |
| train | `train` (bundle + family or a `TrainJobV1`; exports safetensors + manifest + eval.json) |
| evaluate | `evaluate` |
| load / unload | `load` (verifies weights hash, optional expected hash), `unload` |
| predict | `open_session`, `predict` (`PredictRequestV1` in, `ActionProposalV1` out) |
| reset | `reset` (zero state, sequence back to -1) |
| checkpoint | `checkpoint` / `restore` (hidden state + sequence index, hash-checked; restore on another worker gives the same next proposal) |
| close | `close_session`, `shutdown`; also `cancel`, `kill_switch` |

Error codes: `E_BAD_REQUEST E_SCHEMA E_HASH_MISMATCH E_SECRET_DETECTED E_CONSENT E_MODEL_HASH E_NOT_LOADED E_SESSION_UNKNOWN E_SESSION_EXPIRED E_SEQ_DUPLICATE E_SEQ_LATE E_SEQ_GAP E_CAPACITY E_TIMEOUT E_CANCELLED E_RUNTIME_MISSING E_RUNTIME`. Only `E_CAPACITY`, `E_TIMEOUT` and `E_RUNTIME` are retriable.

Sessions are sticky to one runtime: each has its own hidden state, a TTL refreshed on use, an optional `account_scope` that other scopes cannot see, and a strict sequence: the next request must carry `last + 1`. A repeat is `E_SEQ_DUPLICATE`, an older index `E_SEQ_LATE`, a skip `E_SEQ_GAP`. A session limit bounds memory (`E_CAPACITY`).

## The model

hashed-bag/v1 features: task, app, URL pattern, loading flag, focus, the words of visible elements, the previous action, and log1p of the seconds since the last step. A projection feeds a CfC cell, an LTC cell or a GRU cell (same hidden size). Two heads: action type over a fixed list, and a pointer over the visible elements (each element hashed from its role and words). The pointer is what lets a policy trained on "From Dana: Lunch?" click "From Sam: Invoice" later. CfC and LTC also get the real time gap as their timespan.

Proposals carry `confidence` (type probability times pointer probability), `uncertainty` (normalised entropy), up to three alternatives, `requires_approval` for `submit/send/post/publish/delete`, and `abstain_reason` when confidence is below the threshold or no target is visible. A proposal never authorises anything; the executor (W3BS) applies its own stricter gate.

## Privacy and threat model

- Node never runs Python unless a temporal command runs; `infernet model runtime setup --yes` is the only thing that installs it.
- Bundles are verified before training: schema, every content hash, manifest agreement, and a secret scan (keys, tokens, JWTs, cookies, password assignments, Luhn-valid card numbers). The same scan runs in JS before anything is exported.
- A `TrainJobV1` with `privacy.mode = trusted_worker` is refused unless `upload_approved` is true, and a dataset whose consent does not include `model_training` is refused.
- The runtime writes no dataset or observation content to stderr; a test checks this.
- An untrusted worker sees the redacted data it trains on; transport encryption does not change that. Local-only is the default everywhere and remote training needs a trusted worker chosen by the user.

## CLI

```bash
infernet model runtime setup --yes                 # explicit install, CPU lock
infernet model synth --out mock.json --per-task 160
infernet model train --dataset mock.json --output ./model --family cfc --baseline gru
infernet model evaluate --model ./model/cfc --dataset holdout.json
infernet model predict --model ./model/cfc --input steps.jsonl
infernet model serve --stdio                      # the runtime contract, for c0mpute
```

## c0mpute

c0mpute's `plugins/infernet/module.toml` advertises `infernet.temporal.train` and `infernet.temporal.infer` mapped to these commands; its worker filters offers on runtime, CPU/GPU, RAM and model hash, runs one node per training job and keeps an inference session on the worker that holds its state. Receipts carry the model hash as the output hash. See the c0mpute repo.

## Not done yet

- ONNX export (PRD: only after operator-compatibility tests).
- GPU and macOS runs: the CUDA lock exists but no NVIDIA box or Mac has run it.
- Real (non-synthetic) episodes: the benchmark is synthetic. Rerun it on reviewed W3BS episodes before choosing a family.
