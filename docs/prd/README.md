# Feature parity PRDs (2026-10-06)

What the marketing says vs what ships, and what to build or change so they match. Prompted by the 2026-10-06 daily stats report (47 users, 41 nodes, 0 models, 91 pending jobs, 3,351 unsent CPR receipts, 0 payments).

## Headline

| Source | Claims checked | Shipped | Partial | Missing | Broken | N/A |
|---|---|---|---|---|---|---|
| Live site (all pages, npm, GHCR, brew, release) | 95 | 26 | 30 | 18 | 17 | 4 |
| Repo docs (README, PROTOCOL, ARCHITECTURE, docs/, book, whitepaper, IPIPs) | ~244 | ~55 | ~86 | ~75 | ~22 | ~3 |

Full claim tables with file and live evidence: [audit/claims-site.md](audit/claims-site.md), [audit/claims-docs.md](audit/claims-docs.md) (its "Mechanics" section explains job routing, models, node commands, CPR, payments, distributed, training and every daily-report number).

**The short version:** on 2026-10-06 the network had 0 live nodes, nothing bills or pays, CPR receipts cannot be sent, the privacy policy is false, and the npm and Docker install paths are broken. The report's "pending" and "available" numbers were stale rows, now cleaned up by PR #26.

## Already fixed during this audit
- **PR #26**: no-provider chat requests are recorded as `failed` (`no_provider:`), not left `pending` forever; new `POST /api/cron/maintenance` reaper (jobs 1 h, node commands 24 h, providers silent 10 min); report lists served models and live nodes. Deployed; crontab on dev2 every 5 min. First run closed 92 jobs, 21 commands, 20 stale providers.
- **PR #27**: release publishes `@infernetprotocol/rpc-adapter`, so `npm i -g @infernetprotocol/cli` can install again (needs a release).

## PRDs

| # | Area | Priority | One line |
|---|---|---|---|
| [01](01-live-supply.md) | Live supply | P0 | 0 live nodes; keep a floor of house supply, honest /status, operator re-engagement |
| [02](02-job-routing-and-lifecycle.md) | Job routing and lifecycle | P0 | model aliasing (gpt-4o-mini), real queue or no claim, reassignment, self-update kills jobs |
| [03](03-model-catalog.md) | Model catalog | P0 | `models` table is dead; derive from heartbeats everywhere |
| [04](04-node-commands.md) | Node commands | P0 | stuck rows (fixed), 39 failures by cause, fit checks, ANSI garbage |
| [05](05-cpr-receipts-and-reputation.md) | CPR receipts and reputation | P0 | no issuer key, wrong base URL in prod, no cron, reputation never written |
| [06](06-payments-billing-payouts.md) | Payments, billing, payouts | P0 (decisions) | nothing charged or paid; open business decisions |
| [07](07-consumer-api-and-sdk.md) | Consumer API and SDK | P1 | no API keys; documented `/api/v1/jobs` 404s |
| [08](08-privacy-and-security.md) | Privacy and security | P0 | privacy policy says prompts are not stored; they are |
| [09](09-install-and-distribution.md) | Install and packages | P0 | npm (fixed in #27, needs release), Docker image private and wrong owner, brew placeholder |
| [10](10-activation-funnel.md) | Activation funnel | P1 | 21 of 47 unconfirmed (link scanners), no onboarding follow-up |
| [11](11-distributed-inference.md) | Distributed inference | P2 | dead tables, routing bug, Petals/Ray claims |
| [12](12-training-market.md) | Training market | P2 | upload URL bug, completed-when-failed, placeholder backends |
| [13](13-decentralization.md) | Decentralization | P2 | c0mpute P2P discovery claimed, not present |
| [14](14-stats-and-observability.md) | Stats and observability | P0 | every misleading report number, alerts |
| [15](15-docs-accuracy.md) | Docs accuracy | P1 | IPIPs marked Final without code, stale pages |
| [16](16-managed-endpoints.md) | Managed endpoints / reservations | P1 (built 2026-10-09) | one identified operator + exact models by the hour for resellers; keys, limits, per-minute availability proof, post-paid invoice data |

Prioritized work list: [TODO.md](TODO.md). Earlier PRD: [../prds/infernet-train-prd.md](../prds/infernet-train-prd.md).

## Open decisions for Anthony
1. Pricing, take rate ("no platform spread" today), who holds funds (custodial credits vs escrow vs direct), payout schedule and launch coins (PRD 06).
2. Turn on the NVIDIA NIM fallback (costs per request, and it puts a data center in the middle of "no data center in the middle")? (PRD 01)
3. Until payments exist: change the homepage/getting-started "earn crypto" copy to "coming soon"? (PRD 06)
4. What to do with the 3,351 unsent CPR receipts once the issuer key exists: send all, or skip old ones (PRD 05).
5. House supply budget: how many always-on nodes we run (PRD 01).
6. /careers sales roles while nothing is billable (PRD 15).
7. Managed endpoints (PRD 16): accept post-paid / no-minimum terms, price per reserved hour, which operator + model to commit, and the SLA threshold (minutes per hour).
