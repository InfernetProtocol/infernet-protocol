# PRD 12: Training market (IPIP-0030)

Priority: **P2**

## Problem
"Training jobs: 0". The market can run end to end only for an opted-in node with python3 + Unsloth + a GPU and a self-hosted dataset, and it has bugs that make the result unusable.

## Claims being made
- `infernet train`, fine-tuning on the network, DeepSpeed / OpenRLHF / OpenDiLoCo backends (docs/prds/infernet-train-prd.md, book, /docs).

## Current state (evidence)
- Tables `training_jobs`, `training_shards` (`20260501170000_training_market.sql`); create via `POST /api/v1/training/jobs`; claim/report routes exist; daemon executor only with `INFERNET_ACCEPT_TRAINING=1` (`start.js:1528-1540`).
- Adapter upload URL is built over a base that already contains `?token=` (`training-market.js:58` vs `start.js:1169`), so uploads fail.
- A job is marked `completed` even when every shard failed (`training-market.js:186-197`); no reclaim of shards from dead nodes; no adapter merge; `price_per_shard_usd` stored, never paid.
- `@infernetprotocol/training` (DeepSpeed/OpenRLHF/DiLoCo/Petals) is imported by nothing; all four backends are placeholders.

## Requirements
1. Fix the upload URL and the completion status; reclaim shards after a lease timeout (add to the maintenance cron).
2. Merge LoRA adapters into a downloadable artifact.
3. Remove claims for unbuilt backends, or mark them roadmap.
4. Payment for shards follows PRD 06 decisions.

## Acceptance criteria
- A 4-shard job on 2 opted-in nodes produces one merged adapter the submitter can download; a killed node's shard is reclaimed and finished by the other.
