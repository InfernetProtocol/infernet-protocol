# PRD 03: Model catalog

Priority: **P0** (report and site show wrong numbers) / P1 (catalog features)

## Problem
The daily report says "Models: 0". /status says "Models served 33". `/v1/models` says `[]`. All three are wrong in different ways.

## Claims being made
- "Models served" on /status and `/api/overview`; model pages and the `models` table described in the architecture docs; `/api/models`.
- Quickstarts name specific models (`qwen2.5:7b`).

## Current state (evidence)
- `public.models` (`supabase/migrations/20260312000000_initial_infernet_schema.sql:41-48`) is written by nothing; its only rows were demo seeds, deleted by `20260428000000_drop_demo_seeds.sql`. `/api/models` reads it and returns `[]`.
- What nodes really serve is `providers.specs.served_models`, refreshed by every heartbeat (`node-api.js:235-237`). Prod, nodes seen in 24 h: gemma3:4b, llama-3.2-1b, llama-3.2-3b, llama3.2:1b, llama3.2:3b, qwen2.5:0.5b, qwen2.5:3b, qwen2.5:7b, qwen3:4b.
- Served models are only advertised if `engine.ollamaHost` is set (`apps/cli/commands/register.js:168`).
- **Fixed in PR #26:** the daily report lists served models from live nodes and labels the `models` table as the catalog.

## Requirements
1. Derive the catalog from heartbeats: a view or materialized table of model name, live node count, total node count, last served, median tokens/s, context length.
2. `/api/models` and `/v1/models` read that source; `/v1/models` includes aliases from PRD 02.
3. A public /models page: what you can call right now and what has been served in the last 7 days.
4. Normalize names (Ollama tag vs HF repo vs vLLM served name) so the same model on two backends routes as one.
5. Drop or repurpose the `models` table.

## Acceptance criteria
- `/api/models`, `/v1/models`, /status and the daily report agree with a SQL query over `providers.specs` for the same window.
- A node that registers without `ollamaHost` still advertises its models (or the CLI refuses to start with a clear error).
