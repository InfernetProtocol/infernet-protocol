# PRD 15: Documentation and site copy accuracy

Priority: **P1** (P0 for the false privacy and payments copy, tracked in PRD 06 and 08)

## Problem
About 244 documentation claims and 95 site claims were checked. Roughly a third are partial and another third missing or broken (see `audit/`). Copy that promises unbuilt features costs trust the moment a developer tries them.

## Items to correct (not covered by another PRD)
- IPIPs marked Final with no code: 0013 (batch API + BullMQ), 0014 (idempotency, reassignment, circuit breakers), 0005 (mobile talks to Supabase directly, violating it). Move to Draft or build.
- Petals (B.5) still advertised (README, FAQ) though IPIP-0031 is Replaced.
- Homepage lists vLLM as "coming next"; FAQ says it is installed.
- Mojo engine emits canned tokens; docs present it as a backend.
- CONSUMER.md / PROVIDER.md: Nostr sign-up, `infernet/node` image, `app.` and `docs.` subdomains that do not exist.
- INFERNET-ARCHITECTURE.md: the CLI holds a Supabase service-role key (no longer true).
- /docs examples for `infernet payout set` (PRD 06) and `/api/jobs/submit` (404).
- Book chapter 04 consumer API (PRD 07).
- /careers sales roles describe deal sizes for a product with no billing (business call; see PRD 06 open decisions).
- DID document service endpoints 404 (PRD 05).

## Requirements
1. A link and endpoint checker in CI over the book, /docs and README (every documented path must not 404).
2. Each feature claim on the site carries a status (live / beta / roadmap) sourced from one file, so the copy and the code cannot drift silently.
3. Re-run this audit quarterly; keep `audit/` current.

## Acceptance criteria
- 0 documented endpoints return 404.
- No IPIP marked Final lacks a code reference.
