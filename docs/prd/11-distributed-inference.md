# PRD 11: Distributed (multi-node) inference

Priority: **P2** (P1 to correct the copy)

## Problem
The report's "Distributed jobs: 0" is structural, and the feature the site describes is partly not built.

## Claims being made
- Multi-node inference over llama.cpp RPC (IPIP-0033), Petals (B.5) in the FAQ and README, Ray mode (`INFERNET_RAY_MODE`), multi-node aggregator fan-out (IPIP-0028 Phase 3, in TODO).

## Current state (evidence)
- `distributed_jobs` and `node_roles` (`supabase/migrations/20260419000000_cli_support_and_payments.sql:94-129`) are never written; only the daily report reads them.
- The real path is a normal `jobs` row with `input_spec.distributed = true`, proxied by the stream route to an RPC primary (`/v1/rpc/inference`). It needs a primary with an inbound-reachable address and at least 2 slices; `/api/v1/rpc/census?model=qwen2.5:7b` returns 0 primaries, 0 slices.
- Bug: the single-provider pick runs first, so the request 503s unless one node serves the whole model, and that node also runs the job (audit/claims-docs.md M1.8).
- Petals was removed (IPIP-0031 Replaced) but is still advertised; `INFERNET_RAY_MODE` does not exist.

## Requirements
1. Fix the routing bug (skip the single-provider pick when `distributed` is set; fail with a clear census message).
2. Record distributed runs in `distributed_jobs` (or drop the table and count `jobs` where `input_spec.distributed`).
3. Remove Petals and Ray claims.
4. Daily report counts distributed runs from the real source.

## Acceptance criteria
- With 1 primary + 2 slices on a LAN, a `distributed: true` chat completes and the report counts it.
- No page mentions Petals or Ray as supported.
