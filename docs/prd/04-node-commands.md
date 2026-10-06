# PRD 04: Remote node commands (model install / remove)

Priority: **P0** (stuck rows) / P1 (success rate)

## Problem
The report showed 8 pending, 13 running and 39 failed node commands. Of 128 commands ever issued, 56 completed.

## Claims being made
- Dashboard model management: install and remove models on your node from the web; "Push model" UI (book and /docs).

## Current state (evidence)
- Lifecycle: owner issues `model_install` / `model_remove` / `train_shard` via `POST /api/v1/user/nodes/[pubkey]/commands`; daemon polls every 30 s, flips `pending -> running`, acks `completed`/`failed` (`apps/web/lib/data/node-commands.js`, `apps/cli/commands/start.js:623-745`).
- **Fixed in PR #26:** no server-side timeout existed, so commands for nodes that went away stayed `pending`/`running` for months (oldest 2026-04-30). The reaper now fails them after 24 h; 21 were closed on 2026-10-06.
- Failure causes (39): model does not fit RAM/VRAM (9), `ollama pull HTTP 400` (6), `huggingface_hub not installed` (5), vLLM failed to start (5), ollama exit 1 with raw terminal escape codes as the error (5), HF download errors (3), proxy timeouts (2), vLLM not installed (1).
- Errors are stored with ANSI escape codes, so the dashboard shows garbage.

## Requirements
1. Refuse a command at issue time when the target node has not heartbeated in 10 minutes (409 with "node offline").
2. Fit check on the server using the node's advertised RAM/VRAM before issuing an install; show the reason in the UI.
3. The installer sets up `huggingface_hub` (and vLLM where the GPU supports it), or the dashboard hides HF/vLLM models for nodes that lack them.
4. Strip ANSI codes and truncate errors to a readable line before storing.
5. Commands run concurrently with jobs, not inside the job poll tick (`start.js:552-554`).

## Acceptance criteria
- 0 node commands older than 24 h in `pending`/`running` (daily report).
- Install success rate above 80% over 30 days, excluding user cancels.
- No stored command error contains `\x1B[`.
