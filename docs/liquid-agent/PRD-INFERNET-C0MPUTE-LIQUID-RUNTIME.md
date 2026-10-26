# PRD: Infernet Liquid Runtime on c0mpute

**Status:** Proposed · **Dependencies:** Unified Liquid Agent Pipeline PRD

## Outcome
Provide a first-class optional temporal-model workload implemented in Infernet, scheduled and executed on c0mpute nodes, with **both training and stateful inference** for CfC/LTC and baseline GRU networks. Infernet is the AI workload layer; c0mpute is the infrastructure layer. Do not bolt a second neural-network API directly onto c0mpute.

## Current fit
`profullstack/c0mpute` uses a Rust CLI/worker and metadata in `plugins/`; `plugins/infernet/module.toml` dispatches to the upstream `infernet` binary as a subprocess. Infernet's actual adapter APIs and work/job types must be checked at implementation time. Its current support for ordinary LLM inference must not be mistaken for native CfC/LTC support.

## Build

1. In Infernet add `temporal-policy` model family and an isolated `infernet-liquid` executable/container: Python 3.11+, PyTorch, `ncps`, version-locked, with explicit CPU/accelerator capabilities. Do not modify unrelated LLM-serving paths.
2. Implement adapters for `train`, `validate`, `evaluate`, `predict`, `load`, `unload`, `reset`, `checkpoint`, `health`. Map names to upstream adapter interfaces; preserve existing authentication and signing.
3. Dataset: versioned manifest, schema validator, encrypted transport, content-hash verification, no implicit access to user files. Streaming minibatches; train/val/test partition and deterministic seed.
4. Models: support `cfc`, `ltc` (research), and `gru` baseline. Export safetensors and precise model config/preprocessing; optional ONNX only after tests. Assert shape/time-delta compatibility; include reproducible dependency lock.
5. Serving: sequence-aware session handle, TTL, affinity/sticky routing, isolated hidden state, reset/checkpoint, late/duplicate request rejection, concurrency limits, bounded memory, CPU fallback, network timeout and circuit breaker. Store no raw desktop data in logs.
6. c0mpute integration: advertise `infernet.temporal.train` and `infernet.temporal.infer`; scheduler filters on supported runtime, CPU/GPU, RAM, privacy/trust requirements, model hash; dispatch one node per training job in v1; route session to same inference node or restore a checkpoint. Use existing signed manifests/offers/receipts and settlement path.
7. `plugins/infernet/module.toml`: extend advertised workload capabilities and commands **only after** upstream execution is implemented. Avoid inventing a second `liquid` marketplace plugin unless Infernet maintainers require separate packaging.
8. CLI examples (proposed; adapt to actual subcommands):

```bash
infernet model train --family cfc --dataset dataset.json --output ./model
infernet model evaluate --model ./model --dataset holdout.json
c0mpute infernet temporal serve --model sha256:MODEL
c0mpute infernet temporal predict --session session-1 --input step.json
```

9. Observability: signed job status, retriable failure code taxonomy, GPU utilization, cost/budget caps, throughput, latency p50/p95, per-session resource use, task accuracy, and artifact provenance.

## Exit criteria
- Model trained reproducibly on synthetic/mock desktop traces and benchmarked against GRU.
- End-to-end Infernet inference via c0mpute worker, with validated signature/model hash, explicit session reset, and equivalent result on local and remotely served inference within numerical tolerance.
- Run on Linux CPU without GPU; test NVIDIA GPU and macOS where supported.
- No network egress for job data without upload approval; zero credential leakage in telemetry.
- Correct cancellation, worker crash recovery, state isolation across accounts, and cost ceilings.

## Non-goals
No direct GGUF/llama.cpp liquid support assumption; no decentralized synchronous gradient exchange in MVP; no silent model downloads or worker auto-install without user/admin consent; no claim that liquid networks replace LLM planning.

## Order of work
Adapter compatibility audit → local runtime + tests → manifests and c0mpute dispatch → sticky session serving → checkpointing and user-facing metrics → production hardening.
