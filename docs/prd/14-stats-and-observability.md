# PRD 14: Stats, status page and observability

Priority: **P0** (numbers were wrong) / P1 (alerting)

## Problem
The daily report and the public /status page reported numbers that did not mean what their labels said, so the report looked like demand and capacity that did not exist.

## Current state (evidence)
| Number | What it said | What it was |
|---|---|---|
| Jobs pending 91 | queued work | requests no provider could ever serve, stuck forever (fixed, PR #26) |
| Nodes available 20 | capacity | stale status; 0 live (fixed by reaper, PR #26) |
| Models 0 | nothing served | the `models` table nothing writes (fixed in report, PR #26; site still wrong, PRD 03) |
| Node commands 8 pending / 13 running | in progress | dead rows from April to September (fixed, PR #26) |
| CPR pending 3351 / sent 0 | backlog | nothing can send (PRD 05) |
| CPR "Failed (retrying)" | retrying | terminal rows (label wrong) |
| Distributed 0 | no usage | a table nothing writes (PRD 11) |
| Payments 0 | no revenue | no code path creates one (PRD 06) |
| /status "Jobs 100" | total jobs | the query LIMIT |
| /status "Models served 33" | live models | models on offline nodes |
| `/api/health` commit null | unknown build | reads a Railway-only env var |

- Who calls the crons: the user crontab on dev2 (`anthony`), lines for `/api/cron/daily-stats` (08:00 UTC) and, since 2026-10-06, `/api/cron/maintenance` (every 5 min, log `~/.local/state/cron-logs/infernet-maintenance.log`). Nothing calls `/api/cron/cpr` (PRD 05).

## Requirements
1. Fix the CPR label; add a "no_provider (24h)" count with the top requested unserved models (demand signal).
2. /status and `/api/overview`: live-only counts, real totals.
3. `/api/health` reports the deployed commit (bake `GIT_SHA` at image build).
4. Alerts (email to Anthony): live nodes = 0 for 15 min; cron endpoints not called in 2x their interval; job failure rate above 30% in an hour.
5. Funnel section (PRD 10).

## Acceptance criteria
- Every number in the report has a one-line definition in `apps/web/lib/daily-stats.js` and matches a documented SQL query.
- /status numbers match SQL for the same instant.
