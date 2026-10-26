# PRD: W3BS Desktop Training — Liquid Agent

**Status:** Proposed · **Dependencies:** Unified Liquid Agent Pipeline PRD and Infernet Liquid Runtime PRD

## Outcome
Turn existing W3BS Desktop Training into an opt-in demonstration-to-policy product that learns simple repeatable UI tasks and can execute them safely through W3BS Desktop. Train locally or, with explicit reviewed-upload consent, using Infernet jobs on the c0mpute network. Serve activated models from local Infernet or c0mpute workers.

## Existing foundation
`profullstack/w3bs.org` declares `w3bs-training` and schema generation scripts in `package.json`. Extend the actual training package, recording/review UI, evaluation pipeline and W3BS desktop APIs already in-tree; do not create another disconnected site. Before implementation, inspect its concrete modules and schema versions.

## UX

**Capture:** Existing Training UI gains "Teach an agent" session flow: choose one app/window and task, see persistent recording indicator, pause/resume/stop, capture accessible UI tree/DOM semantics and action events (click, type with secret masking, scroll, navigation, timestamps), optional screenshots, state transition and outcome. Passwords/secrets excluded at capture. No capture before explicit per-session permission.

**Review:** Timeline with playable events, step grouping, labels `goal`, `observation`, `action`, `result`, `success`, `failure_reason`, confidence and permission boundary. Fast keyboard labeling, bulk segmentation, deduplication, redact preview, reversible edits, dataset versioning. Keep raw trace only on device unless user explicitly authorizes upload.

**Train:** Dataset wizard validates coverage and train/val/test splits; toggles `CfC`, `LTC` research, `GRU` baseline, `script/LLM` baseline; display privacy mode `Local only` by default vs `Trusted c0mpute worker` opt-in, estimated cost, deletion terms, max steps, requested compute. Single button submits via Infernet adapter.

**Evaluate:** Interactive replay on throwaway accounts/mock sites, A/B model comparison, failure replay, per-step interventions, task success, generalization to changed layout, latency/cost. Show actionable labels for data gaps. Never proclaim model ready based on training loss alone.

**Use:** Policy activation by task/app, with capability check, clear model source/weights hash, canary mode, confidence thresholds and human approvals. LLM continues high-level planning; policy predicts lower-level UI actions and can abstain. Guarded executor checks action scope and current UI before executing. One-click fallback, rollback, delete.

## Workflow requirements

- **Email:** open inbox, find message, draft reply; *sending* requires confirmation. Prefer provider APIs/accessibility selectors rather than screen coordinates when available.
- **Reddit:** navigate to subreddit, compose post, preview; *publishing* requires confirmation and platform compliance.
- **LinkedIn:** navigate feed or notifications, summarize, compose drafts; external outreach or publishing requires confirmation and platform compliance.
- All workflows start with fixtures/mock sites; later permitted real integrations with user-provided credentials stored in OS keychain, not training exports.

## Technical interface

- Implement W3BS `EpisodeV1`, `DatasetManifestV1`, `TrainJobV1`, `ModelManifestV1`, `ActionProposalV1` as schemas matching `liquid-agent/v1` from umbrella PRD.
- Desktop capture adapter → local episode store → labeling/redaction → dataset exporter → Infernet train client → c0mpute job monitor → evaluation harness → inference client → guarded desktop action executor.
- Separate permissions: recording, training data use, network upload, remote inference, automatic action execution. Show current statuses and logs.
- Model switch `Off / Suggest / Execute with approval / Bounded automation`; default **Off** for newly installed users until consent. Once user enables and capability checks succeed, *Suggest* may be recommended as default; any broader autonomy is separately authorized.
- Prefer semantic observations (accessibility tree, element IDs, page state) over screenshot-only policy; add vision encoder later if benchmarking justifies it. Time deltas and prior actions should be explicit features for CfC/LTC.
- Queue corrections as new proposed examples but require review and permission before adding to dataset; do not silently record or upload.

## Acceptance tests

1. Record and label 20 test episodes in W3BS; export validated redacted dataset without credential leakage.
2. Submit dataset to local Infernet; train CfC and GRU; return model manifests and reproducible evaluation report.
3. With user consent, submit to c0mpute; retrieve signed artifact; activate inference through Infernet.
4. Desktop test agent completes the mock draft-reply, mock Reddit post compose, and mock LinkedIn notification-review workflows, showing every proposed action and correct human approval for external writes.
5. Recording/privacy controls, stop switch, logout/timeout and session reset work under fault injection and account switching.
6. Performance report compares models on held-out sessions and layout variants; deployment requires explicit quality and safety thresholds, not just lower inference latency.

## Milestones

- **M0:** code audit, UX wireflow, source-level redaction, schema and permission contracts.
- **M1:** local recorder → reviewer → export → CfC/GRU training → mock-task evaluation.
- **M2:** Infernet/c0mpute job integration, model registry, signed results, cost controls.
- **M3:** guarded policy serving in Desktop, feedback-to-dataset workflow, polished Training dashboard and staged rollout.

## Risks
Capture may miss semantic context; websites change frequently; training small models can overfit; action sequence prediction may be weaker than accessibility-based deterministic automation. Mitigations: benchmark baselines, preserve user control, train on diverse held-out sessions, fail closed, and make the feature fully optional.
