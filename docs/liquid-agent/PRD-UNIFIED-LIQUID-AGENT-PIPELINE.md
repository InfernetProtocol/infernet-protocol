# PRD: Unified Liquid Agent Pipeline

**Status:** Proposed · **Date:** 2026-10-25 · **Owners:** W3BS, Infernet Protocol, c0mpute

## 1. Product goal

Build one interoperable, opt-in system that turns consented desktop demonstrations into high-quality action traces, trains and evaluates small temporal agent policies (initially CfC/LTC liquid neural networks), and serves those policies through Infernet Protocol on c0mpute's decentralized workers. The system must also support ordinary baselines (GRU/LSTM/MLP or deterministic scripts) so a liquid architecture is *selected only when it performs better*.

Target demonstrations: checking LinkedIn, drafting/replying to email, and preparing Reddit posts. All external posting, sending, deleting, or account-changing actions require explicit per-action approval or a narrowly scoped user-approved policy. Start in sandbox/mock environments and never bypass provider limits or anti-bot controls.

## 2. Existing architecture and ownership

- **W3BS (`profullstack/w3bs.org`)**: `w3bs-training` CLI already declared in `package.json`; extend its existing training UX, schema, evaluation, and desktop capture rather than creating a second training product.
- **Infernet (`InfernetProtocol/infernet-protocol`)**: AI workload/model runtime above c0mpute; extend existing inference/training adapter contracts with a temporal-policy adapter. Confirm version-specific adapter shape before coding.
- **c0mpute (`profullstack/c0mpute`)**: Rust CLI/worker, decentralized dispatch and model-capable nodes; its `plugins/infernet/module.toml` delegates to an `infernet` subprocess. Do not introduce a central scheduler or a duplicate inference network.

**Flow:** W3BS capture → local redact/review/label → versioned dataset → Infernet train adapter → c0mpute worker execution → evaluation/model registry → Infernet serve adapter on c0mpute → W3BS desktop agent consumes action predictions → guarded executor → feedback trace.

## 3. Principles and non-goals

1. **Optional and recommended when compatible:** expose the temporal policy feature by default; enable model suggestions after compatibility checks and user opt-in. **Recording, upload, remote training, and autonomous action are OFF until explicit consent**. Provide one-click disable/delete/export.
2. Local-first: raw screenshots, keystrokes, browser content and secrets never leave device by default. Only user-reviewed, redacted datasets may be uploaded.
3. Runtime-neutral contracts: no hard dependency on Python in the core Rust worker or Bun W3BS server. Python/PyTorch runtime is an isolated, version-pinned subprocess/container.
4. LLM plans and interprets; specialized policy proposes low-level next actions. Neither authorizes risky actions on its own.
5. Reproducible, signed artifacts and auditable execution. No claim of general desktop reliability without evaluation.
6. No new chain, coin, centralized control plane, or mandatory hosted account.

## 4. Shared contract v1

Use JSON Schema with `schema_version: "liquid-agent/v1"` for interchange and canonical JSON hashing/signing with existing network primitives where possible.

### Demonstration episode

```json
{
  "schema_version": "liquid-agent/v1",
  "episode_id": "ep_...",
  "task": "email.reply_draft",
  "created_at": "2026-10-25T12:00:00Z",
  "capture": {"consent_id": "...", "redaction_profile": "strict", "device_local": true},
  "steps": [
    {"t_ms": 0, "observation": {"app": "mail", "ui_tree_ref": "sha256:...", "image_ref": null},
     "action": {"type": "click", "target": {"role": "button", "name": "Reply"}},
     "result": {"status": "ok"}}
  ],
  "labels": {"success": true, "reviewed": true, "risk": "low"},
  "content_hash": "sha256:..."
}
```

Additional objects: `DatasetManifest` (episodes, splits, license, provenance, consent, retention), `TrainJob` (dataset_hash, model_type, hyperparameters, resource needs, max_budget), `ModelManifest` (weights_hash, architecture, runtime, input/output schemas, training provenance, eval metrics, license), `InferenceSession` (model_hash, session_id, sequence index, TTL, state/checkpoint ref), and `ActionProposal` (action, confidence, uncertainty, requires_approval, abstain_reason). Dataset train/validation/test split by task/session/account to prevent leakage; never embed raw credentials or cookies.

### API responsibilities

- W3BS: `POST /training/episodes`, `POST /training/datasets`, `POST /training/evaluate`, `POST /training/jobs`, `GET /training/jobs/:id`, `POST /training/models/:id/activate`; authenticated local APIs / MCP equivalents with least privilege.
- Infernet: adapter operations `train`, `evaluate`, `load`, `predict`, `reset_session`, `close_session`, `health`, `capabilities`; map to real upstream version rather than defining a conflicting public API.
- c0mpute: dispatch signed compute jobs, advertise GPU/CPU and runtime capabilities, transfer verified encrypted/redacted artifacts, return signed results and receipts. Prefer existing job protocol and plugin metadata.

All submitted jobs have idempotency keys, bounded retries, cancellation, resource ceilings, timeout, explicit retention, and content hashes. Sessions are sticky to a single serving worker unless state is safely checkpointed and restored.

## 5. End-to-end UX

1. User opens W3BS Desktop Training and explicitly starts a scoped recording (chosen apps/windows, duration, sensitive-data exclusions).
2. User demonstrates a single task; recorder captures timestamped UI tree / DOM/accessibility events, pointer/keyboard events, application transitions, and optional screenshots. Sensitive inputs excluded at source.
3. W3BS segments demonstrations into episodes and suggests concise task/action labels; reviewer fixes labels, masks content, marks success/failure, and approves dataset export.
4. User selects `Train local` or opt-in `Train on c0mpute`, with cost/privacy/worker-trust preview. Infernet creates job and invokes suitable c0mpute workers.
5. System trains CfC and at least GRU baseline using identical splits and resources; stores immutable manifests, checkpoints, accuracy, latency and failure metrics.
6. Evaluator replays tasks in disposable test accounts/mock sites, with approval gates for external side effects.
7. If compatibility, confidence, reliability and cost thresholds pass, user can activate an Infernet-served policy for *suggestions*; guarded desktop executor can perform approved actions and solicit correction.
8. Each corrected run may become a new, separately consented episode; no silent continual learning or uploads.

## 6. Safety and privacy gates

- Per-application allowlist; visible recording indicator; pause and immediate stop; encryption at rest and in transit; configurable retention; deletion propagation for user-owned artifacts where operationally possible.
- Default exclude password fields, passkeys, tokens, private keys, payment details, clipboard secrets, and personally identifying content; allow manual field-level redaction and review before network transfer.
- Separate consent controls for capture, data reuse, cloud/decentralized training, inference, and auto-execution. Persist audit trail with timestamp, scope, and revocation.
- External messages/posts, financial operations, destructive edits, security-sensitive changes: require approval at action time unless user explicitly configures bounded delegated rules. Social platform terms and rate limits must be respected.
- Untrusted worker threat model: sending redacted data to an untrusted host still exposes it. Offer **local-only** as default and trusted/private worker selection; never claim encryption-in-transit protects plaintext inside a worker.
- Reject out-of-schema actions and stale sessions; allow kill switch, bounded step count, timeout, rollback where possible, and evidence of what was actually executed.

## 7. Measurable acceptance criteria

- End-to-end: 20 consented example episodes → reviewed dataset → train CfC and GRU → evaluate → publish model → infer next action via remote/local Infernet → execute in a test desktop with audit log.
- No capture without explicit opt-in, even on fresh install; no upload before preview and explicit opt-in; disabling feature restores deterministic/LLM baseline.
- Every inference request tied to immutable model hash and isolated session; repeated/late sequence IDs rejected; kill switch effective before next action.
- Benchmark at least 3 realistic workflows on ≥30 held-out episodes each, across different UI variants, reporting task success, intervention rate, latency p50/p95, cost, and failure modes. **Liquid wins only if it improves predeclared metrics over GRU/LLM/script baselines**.
- CI validates contracts across all three repositories; untrusted data redaction tests; deterministic replay fixtures; versioned API compatibility.

## 8. Delivery stages

**Phase 0 — Audit/contracts:** enumerate W3BS current recorder fields, Infernet adapters, c0mpute jobs; define schemas and fixtures; privacy threat model.

**Phase 1 — Local vertical slice:** 1 mock workflow, W3BS episode labeling, PyTorch `ncps` CfC and GRU baseline, local inference adapter, manual action approval, evaluation dashboard.

**Phase 2 — Network execution:** versioned Infernet adapter, worker capability ads, signed job/artifact transport via c0mpute, checkpoint/resume, costs/receipts; separate train vs serve.

**Phase 3 — Productize:** email/Reddit/LinkedIn demonstrations in sandbox and permitted APIs; model catalogue, user-friendly consent, staged deployment, rollback, benchmarking on varied machines.

## 9. Explicit decisions

- Name working feature **W3BS Liquid Agent**; internal workload IDs `infernet.temporal.train`, `infernet.temporal.infer` (proposed; reconcile with upstream namespace).
- Begin with **CfC** due to practical runtime simplicity; retain LTC research mode. No claim that CfC improves all desktop tasks.
- Train locally by default. Distributed multi-node training is out of scope for MVP; decentralized **single-worker jobs** and multi-worker replicated serving first.
- Use neutral interchange artifacts (safetensors + manifest, optional ONNX after operator compatibility testing). Never assume GGUF/llama.cpp supports CfC or LTC.
- Deployment compatibility is opt-in; suggested enablement after proven benchmark and permission, never default surveillance.

## 10. Dependencies and source-of-truth links

- https://github.com/profullstack/w3bs.org (`package.json` declares `w3bs-training`)
- https://github.com/profullstack/c0mpute (`README.md`, `plugins/infernet/module.toml`)
- https://github.com/InfernetProtocol/infernet-protocol (confirm currently implemented APIs per branch)
- https://github.com/mlech26l/ncps (CfC/LTC implementation)

This is a product/implementation specification, not a claim that the feature or all named endpoints already exist.
