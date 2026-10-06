# PRD 01: Live supply (a network that is actually online)

Priority: **P0**

## Problem
On 2026-10-06 the network had **0 live nodes**. 41 providers have registered since April, 2 were seen in the last 24 h, and the last heartbeat was 2026-10-05 21:05 UTC. Every chat request and every `/v1/chat/completions` call fails with 503, and `GET /v1/models` returns an empty list. Interest is arriving (18 sign-ups in September, 3 so far in October) into a product that cannot serve one request.

## Claims being made
- "Earn crypto for the GPU you already have", "a decentralized GPU inference network" (/, /getting-started).
- /status and `/api/overview` show "Models served 33" and "Jobs 100"; providers show `status: available`.
- The OpenAI quickstart on /getting-started uses `model: qwen2.5:7b`.

## Current state (evidence)
- `providers`: 41 rows. Before PR #26, 20 of them said `available` with `last_seen` up to 5 months old. A heartbeat sets `available` (`apps/web/lib/data/node-api.js:226`) and nothing set `offline` when heartbeats stopped. PR #26 adds `POST /api/cron/maintenance` (every 5 min on dev2), which flipped all 20 to `offline`.
- Routing only uses providers seen in the last 2 minutes (`apps/web/lib/data/chat.js:37-61`). Today none qualify.
- `NVIDIA_NIM_API_KEY` is empty in prod `app.env`, so the documented NIM fallback (`chat.js:245`) is off.
- `/api/overview` "Models served 33" counts models on offline nodes; "Jobs 100" is the query limit (see audit/claims-site.md, live API snapshot).
- Operators churn: 23 of 39 failed jobs ended with `daemon restarting for self-update`, so the auto-updater kills in-flight work (PRD 02).

## Requirements
1. A floor of always-on supply we control: at least 2 house nodes (any of: a GPU box, a CPU box serving `qwen2.5:0.5b`/`qwen2.5:7b`, or the NIM fallback) so the quickstart model and the playground always answer.
2. Decide whether the NIM fallback is on (needs `NVIDIA_NIM_API_KEY`; see open decisions). If on, map requested model names to NIM model ids and refuse unknown ones instead of forwarding them (`chat-stream.js:143`).
3. /status, `/api/overview` and the homepage show live numbers only: nodes with a heartbeat in the last 10 minutes, models served by those nodes, real job counts (not a LIMIT).
4. Operator retention: email the owner (via `pubkey_links`) when their node has been silent for 24 h, with the one-line restart command.
5. An alert to Anthony when live nodes = 0 for more than 15 minutes.

## Acceptance criteria
- `GET /v1/models` is non-empty 99% of 5-minute samples over a week.
- The /getting-started quickstart curl returns a completion on a fresh run.
- /status "online" equals the count of providers with `last_seen` within 10 min (checked against SQL).
- A zero-supply alert fires in a test where house nodes are stopped.
