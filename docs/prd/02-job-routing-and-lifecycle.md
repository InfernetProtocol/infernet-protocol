# PRD 02: Job routing and lifecycle

Priority: **P0**

## Problem
The daily report showed 91 pending jobs and 39 failed. None of the pending jobs could ever run, and many failures were self-inflicted.

## Claims being made
- "If you request a model that no node currently has loaded, the job will queue until a node with that model is available" (book, 04-building-apps/index.md:21).
- "Jobs have a server-side timeout of 5 minutes ... the control plane detects the missed heartbeat ... re-queues the job on a different node" (book, job-lifecycle.md:101-105).
- IPIP-0014 (idempotency, reassignment, circuit breakers) is marked Final.
- OpenAI compatibility: "Drop this URL into anything that speaks OpenAI" (`apps/web/app/v1/chat/completions/route.js`).

## Current state (evidence)
- Jobs are pushed once, at creation, by `createChatJob` (`apps/web/lib/data/chat.js:206`). Daemons poll only for jobs `assigned` to themselves (`node-api.js:254-260`). Nothing claims an unassigned job and nothing re-assigns.
- **Fixed in PR #26:** a request no live provider could serve was inserted as `pending` and then answered 503, so it sat forever. All 91 pending rows were these (all `type=chat`, all `provider_id IS NULL`, 2026-04-28 to 2026-10-02). They are now recorded as `failed` with `error = 'no_provider: ...'`, and the 1-hour reaper expires stuck `pending`/`assigned`/`running` rows. Prod after the reaper ran: 629 completed, 131 failed, 0 pending.
- `gpt-4o-mini` (5 requests, 2026-09-24 to 10-02): no provider advertises OpenAI model names and nothing maps them, so they can never be served. Clients that default to OpenAI model names (LangChain, Cursor, openai-python) will hit this every time.
- Failed jobs by cause (prod, 39 before the reaper): 23 `daemon restarting for self-update`, 7 out-of-memory on load, 4 `fetch failed`, 3 no model configured, 2 model not found or invalid.
- `distributed: true` still goes through the single-provider pick, so it 503s unless one node serves the whole model, and that node then runs the job too (audit/claims-docs.md, M1.8).
- `usage` in completions is always zeros (`completions/route.js:211-213`); `top_p`, `stop`, `n` and tools are ignored.

## Requirements
1. **Model aliasing.** A server-side alias table maps common OpenAI/Anthropic names (`gpt-4o-mini`, `gpt-3.5-turbo`, ...) to a served open model, returned in the response `model` field, with a header saying which model actually ran. Unknown models get a 404 `model_not_found` in OpenAI's shape listing what is served.
2. **Honest queueing.** Either implement a real queue (pending jobs claimable by any live node that serves the model, with a TTL) or remove the "will queue" claim. Recommended: short queue (60 s) with SSE keep-alives, then 503.
3. **Reassignment.** An `assigned` job not acknowledged within 30 s is re-assigned to another eligible provider once.
4. **Self-update must drain.** The daemon finishes or hands back in-flight jobs before restarting for an update, and never updates mid-job.
5. **Fit check before advertising.** A node does not advertise a model its RAM/VRAM cannot load (7 OOM failures).
6. Count `usage` tokens (prompt and completion) from the engine and return them.
7. Fix the distributed flag so RPC mode does not require a single full-model provider.

## Acceptance criteria
- `jobs` never holds a `pending` row older than the queue TTL (SQL check in the daily report).
- `model: "gpt-4o-mini"` returns a completion from an aliased model, or a 404 listing served models; never a silent 503.
- A daemon update during a job produces zero `daemon restarting for self-update` failures in a test.
- `usage.total_tokens > 0` on completions from Ollama and vLLM backends.
