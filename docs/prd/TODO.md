# Feature parity TODO (2026-10-06)

From the PRDs in this folder. P0 = a claim that is false today or a number that is broken. P1 = activation and growth funnel. P2 = the rest. `[x]` = done during the audit.

## P0

### Numbers and stuck state
- [x] Stop inserting `pending` jobs nobody can serve; record `failed` + `no_provider:` (PR #26) - PRD 02
- [x] Reaper cron for jobs (1 h), node commands (24 h), silent providers (10 min) (PR #26, dev2 crontab `*/5`) - PRD 02, 04, 14
- [x] Daily report: served models from live nodes, live node count (PR #26) - PRD 03, 14
- [x] Daily report: fix CPR "Failed (retrying)" label; add no_provider demand (top unserved models); failures by cause; drop the never-written models-catalog rows - PRD 14
- [ ] /status and `/api/overview`: live-only counts, real job total (not the LIMIT) - PRD 01, 14
- [ ] `/api/models` and `/v1/models` from heartbeats; drop or repurpose the `models` table - PRD 03

### Supply
- [ ] Decide NIM fallback (open decision) and/or stand up 2 house nodes serving the quickstart model - PRD 01
- [ ] Alert when live nodes = 0 for 15 min - PRD 01, 14
- [x] Model aliasing: `gpt-4o-mini`, `auto*`, other hosted-API names run on a served model; real open-model names 503 with the served list - PRD 02
- [ ] NIM: never forward unknown model names (aliases now get the NIM default; unknown open names still forwarded) - PRD 01

### CPR
- [x] One receipt per job: node job completion is idempotent (3,353 receipts were queued for 695 jobs; one job had 353) - PRD 05
- [ ] Receipts as queued can never be accepted by CoinPay: no `signatures.escrow_sig`, null `currency`/`escrow_tx`/`sla`/`artifact_hash` fail its zod schema, and `amount: 0` is under its 0.01 minimum. Sign + drop nulls before turning the drain on - PRD 05
- [ ] Register Infernet as a CoinPay CPR issuer; put `CPR_ISSUER_API_KEY` in vault + prod env - PRD 05
- [ ] Remove the wrong `CPR_API_BASE_URL=https://coinpayportal.com/api/cpr` from prod env (404; code default `/api/reputation` is right) - PRD 05
- [ ] Decide the 3,351 backlog, then add `/api/cron/cpr` to the dev2 crontab - PRD 05

### False claims (copy or code, today)
- [ ] Privacy policy and FAQ: prompts/completions ARE stored (encrypted); fix the copy or add retention - PRD 08
- [ ] Payments copy: "earn crypto", "pay in any chain", escrow, Lightning, generated wallets (pending decisions) - PRD 06
- [ ] `infernet payout set` docs on /getting-started and /docs are both wrong; add address validation - PRD 06
- [ ] Privacy subprocessors (Railway -> dev2) and `/api/health` commit - PRD 08

### Install
- [x] Publish `@infernetprotocol/rpc-adapter` in the release job (PR #27) - PRD 09
- [ ] Cut release 0.1.54 and verify `npm i -g @infernetprotocol/cli` in a clean prefix - PRD 09
- [ ] Make the GHCR provider image public; fix `ghcr.io/profullstack` on /protocol; drop the service-role key from release notes - PRD 09

### Job reliability
- [x] Daemon must not self-update mid-job (23 of 39 failures): skips the check while busy, drains up to 10 min - PRD 02
- [ ] Do not advertise models that do not fit RAM/VRAM (7 OOM failures) - PRD 02

## P1: activation and growth
- [ ] Email confirmation that survives link scanners (OTP or confirm button); resend button - PRD 10
- [ ] Onboarding sequence: install help day 0/2, node-silent nudge day 7 - PRD 10
- [ ] CLI first-run end-to-end check after `infernet setup` - PRD 10
- [ ] Funnel section in the daily report - PRD 10, 14
- [ ] API keys with per-key limits; persistent rate limiting - PRD 07
- [ ] Return real `usage` tokens - PRD 02, 07
- [ ] Build or delete `/api/v1/jobs`, `/api/v1/jobs/batch` (book, FAQ) - PRD 07
- [ ] Re-assign `assigned` jobs not picked up in 30 s - PRD 02
- [x] Node commands: refuse to offline nodes (409), strip ANSI from stored errors - PRD 04
- [ ] Node commands: server-side fit check, install `huggingface_hub` - PRD 04
- [ ] Owner email when their node is silent 24 h - PRD 01
- [ ] Delete-account flow - PRD 08
- [ ] Sanitize heartbeat specs like register does - PRD 08
- [ ] Docs CI: link/endpoint checker; feature status file driving site copy - PRD 15
- [ ] IPIPs 0005/0013/0014 back to Draft or build them; remove Petals/Ray/Mojo/c0mpute-as-live claims - PRD 11, 13, 15

## P2
- [ ] Billing, metering, provider ledger and payouts (after decisions) - PRD 06
- [ ] Sign CPR receipts with the DID key; fix `did.json` endpoints; feed reputation back - PRD 05
- [ ] Distributed routing fix; record distributed runs - PRD 11
- [ ] Training: upload URL, completion status, shard reclaim, adapter merge - PRD 12
- [ ] E2E encryption for responses - PRD 08
- [ ] Real brew formula; prebuilt installer bundle pinned to releases - PRD 09
- [ ] P2P path without the control plane - PRD 13
