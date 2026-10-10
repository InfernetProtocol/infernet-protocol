# PRD 16 — Managed endpoints / reservations

**Status:** built 2026-10-09. **Priority:** P1 (a reseller asked for exactly this on 2026-10-08).

## Problem

A reseller (first ask: an AI company planning to resell model access to its own customers) does not want "access to a pool of nodes". It wants one **identified operator** serving **agreed exact models** for a **reserved whole-hour block** (60 continuous minutes per hour), with **included tokens** and agreed **per-key and shared throughput + concurrency limits**. It manages its own customers' access and billing, pays nothing up front, and pays post-paid only after it has verified **full confirmed compliant availability — including reserved hours with no requests**.

The open-market path (`/v1/chat/completions` with no key, reputation-weighted pick across live nodes, NIM fallback) cannot promise any of that: the serving node changes per request, there is no per-customer key, no limits beyond an IP rate limit, and no record of availability when nobody is calling.

## What ships

| Piece | Where |
|---|---|
| Schema: `reservations`, `reservation_keys`, `reservation_probes` (one row per reservation-minute), `reservation_usage`, `reservation_add_tokens()` | `supabase/migrations/20261009000000_managed_reservations.sql` |
| Rules (validation, limiter, compliance, invoice) — pure, unit-tested | `apps/web/lib/reservations/core.js`, `tests/reservations.test.js` |
| DB access | `apps/web/lib/data/reservations.js` |
| Probing + talking to the pinned target | `apps/web/lib/data/reservation-upstream.js` |
| Serving reservation keys on `/v1/chat/completions` + `/v1/models` | `apps/web/lib/reservations/serve.js` |
| Management API | `apps/web/app/api/v1/reservations/**` |
| Per-minute prober | `POST /api/cron/reservations` (dev2 crontab, every minute) |
| CLI | `infernet reservation …` (incl. `watch`, the live terminal view) |
| MCP | `infernet mcp` (stdio) — `reservation_*` tools |
| Public docs | `/docs/managed-endpoints` |

### Reservation

Exact `models[]`, `operator_name`, and exactly one target: `provider_id` (a registered Infernet node) or `endpoint_url` (+ optional upstream API key, stored encrypted with `INFERNET_DB_ENCRYPTION_KEY`) for an operator-run OpenAI-compatible server. `start_at` must be a whole UTC hour (DB constraint too); `hours` 1–720. `included_tokens`, `per_key_rps`, `per_key_concurrency`, `shared_rps`, `shared_concurrency`, `required_minutes_per_hour` (default 60 = every minute), `probe_completion`, `price_per_hour` + `currency` (null = not priced). Window, target and models are immutable; book a new reservation to change them. Cancelling makes every hour non-billable and stops the keys.

### Keys and auth

- **Admin** (book, price, cancel, rotate buyer token): `Authorization: Bearer $INFERNET_ADMIN_TOKEN` (≥32 chars, in the vault) or a CLI bearer whose email is in `INFERNET_ADMIN_EMAILS` / id in `INFERNET_ADMIN_USER_IDS`.
- **Buyer token** (`ifr_buy_…`, returned once at booking, rotatable): scoped to one reservation — show, report, invoice, and issue/list/revoke that reservation's keys. Cannot change terms.
- **Reservation keys** (`ifr_res_…`, sha256-hashed at rest, shown once): what the reseller hands its customers. OpenAI-compatible: `OPENAI_BASE_URL=https://infernetprotocol.com/v1`.

### Routing and limits

A reservation key never touches the open-market path. Outside the window: 403 `reservation_upcoming|ended|cancelled`. Unreserved model: 400 `model_not_reserved`. Node targets run as a chat job pinned to that provider with `pinned: true` (no re-pick, no alias rewrite, no NIM fallback); endpoint targets are proxied (streaming passes bytes through and reads the usage chunk via `stream_options.include_usage`).

Limits are enforced in process memory (one Next.js process serves the site): sliding-1s RPS and in-flight concurrency, per key and shared; included tokens via an atomic DB counter. Refusals are 429 with `X-Infernet-Limit-Type` (rps|concurrency|tokens), `X-Infernet-Limit-Scope` (key|shared), `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`, and are logged as limit hits. A multi-process deployment would move the limiter to Redis.

### Availability proof

Every minute the cron probes each open reservation's target and upserts `(reservation_id, minute)`:

- endpoint: `GET {base}/models` lists every reserved id; with `probe_completion`, a 1-token completion per model succeeds and reports the same model.
- node: heartbeat < 90 s, `status = available`, every reserved model in `specs.served_models`. (Nodes are outbound-only, so the heartbeat is the strongest signal without spending a job per minute. Endpoint targets give the stronger proof.)

A minute is **confirmed** when its probe is ok and no real request failed upstream in it. **No row = unconfirmed** — we never assume a minute we did not observe. An hour is **compliant** when confirmed ≥ `required_minutes_per_hour`; idle hours are judged the same way. Unfinished hours are `in_progress`/`upcoming` and never billed.

### Report and invoice

`GET /api/v1/reservations/:id/report[?minutes=1]` — per hour: status, confirmed/failed/unconfirmed minutes, failure reasons, avg probe latency, requests, ok vs upstream errors, prompt/completion tokens (flagged estimated where the upstream did not report usage), limit hits by type; plus totals and the rule text. `?minutes=1` adds every raw probe record so the buyer can recompute verdicts.

`GET /api/v1/reservations/:id/invoice` — lines per hour and `amount_due = compliant hours × price_per_hour + setup_fee` (setup fee only once an hour is compliant); `final` only once all hours ended; `amount_due: null` while unpriced. **No payment is requested or executed** (no Stripe, no CoinPay call).

## Ops

- Migration applied by hand on dev2 (`docker exec -i infernetprotocol-com-supabase-db psql …`), then `NOTIFY pgrst, 'reload schema'`.
- Crontab on dev2: `* * * * *` POST `/api/cron/reservations` with `CRON_SECRET`, log `~/.local/state/cron-logs/infernet-reservations.log`.
- `INFERNET_ADMIN_TOKEN` in `app.env` and the vault.

## Not decided (business)

Whether to accept post-paid with no minimum; price per reserved hour; which operator and model to commit (the network had no live third-party nodes on 2026-10-06, so a first reservation would be house-run supply or a named partner endpoint); the SLA threshold (60/60 minutes or fewer) and whether per-request error budgets count.

## Later

Redis-backed limiter for multi-process; per-reservation latency SLO (p95) in the verdict; signed (Ed25519/Nostr) report snapshots so a buyer can hold proof offline; buyer dashboard page; overage pricing beyond included tokens.

## Pricing (2026-10-10)

Price list in `apps/web/lib/reservations/pricing.js`, public at `GET /api/v1/reservations/pricing` and `infernet reservation pricing`. Booking with `gpu_class` (l40s $1.35, a100 $1.89, h100 $3.99, h100x2 $7.99 per compliant hour) sets `price_per_hour` and `setup_fee` ($5 + one hour, for GPU warm-up); a lower `price_per_hour` is refused. Prices = dedicated-GPU cost (RunPod on-demand, Sep 2026) ÷ 0.79 (20% margin + ~1% payment fee) × 1.05 (only compliant hours are paid). Platform overhead is under 1¢/hour. Migration `20261010000000_reservation_pricing.sql` adds `gpu_class` and `setup_fee`.
