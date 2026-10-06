# PRD 07: Consumer API, API keys and SDK

Priority: **P1**

## Problem
Developers arriving from the docs find a public, unauthenticated endpoint capped at 20 requests/hour per IP, and a documented developer API that does not exist.

## Claims being made
- "The public endpoint is OpenAI-compatible" (/getting-started).
- Book chapter 04 documents `POST /api/v1/jobs`, `GET /api/v1/jobs/:id` and dashboard API keys; /docs mentions `/api/jobs/submit`; FAQ and README mention `/api/v1/jobs/batch` (IPIP-0013, marked Final) with BullMQ.
- "Bring your own API key" (site).
- `@infernetprotocol/sdk-js` usage examples.

## Current state (evidence)
- `/api/v1/jobs`, `/api/v1/jobs/:id`, `/api/jobs/submit`, `/api/v1/jobs/batch` all return 404 (live, 2026-10-06).
- No API key model, table or route. `Authorization` on `/v1/chat/completions` is ignored. Rate limit is in-memory per IP (`completions/route.js:30`), reset on every deploy and not shared across instances.
- `usage` always 0 (PRD 02).

## Requirements
1. API keys: create/revoke in the dashboard and CLI, hashed at rest, scoped per account, sent as `Authorization: Bearer`.
2. Per-key rate limits and quotas stored server-side; anonymous tier stays for the playground.
3. Either build `/api/v1/jobs` (async submit + poll) or delete it from the book; same for batch (IPIP-0013 back to Draft if not built).
4. SDK and docs examples run in CI against a staging or mock endpoint.
5. OpenAI-shape errors for 401/429/404 model.

## Acceptance criteria
- `curl` with a valid key gets per-key limits; without a key gets the anonymous limit; revoked keys get 401.
- Every endpoint documented in the book returns non-404, or is removed from the book (link check in CI).
