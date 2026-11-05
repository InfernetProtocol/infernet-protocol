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

## Self-serve orders (2026-10-27)

Anyone can book without an admin: the website (/order), the CLI (`infernet order`), the MCP server
(`order_capacity`, `order_quote`, `order_create`, `order_status`) and the API.

- `GET /api/v1/orders/capacity`: per GPU class, list price, free online nodes from the next hour, models served.
- `POST /api/v1/orders { gpu_class, models[], hours, start_at?, email?, provider_id?, pay? }` matches ONE online,
  non-private node that reports that GPU class (from `specs.gpus`, A100 must report >=48gb) and already serves
  every model, with no live reservation or held order in the window. Nothing fits = 409; we never take money for
  capacity we cannot pin.
- Priced from our cost: price_per_hour = cost_per_hour x (1 + minimum profit margin), rounded up to the cent.
  The margin is a house setting, 1% to 2000%, default 100% (settings key `orders`, env `INFERNET_ORDER_MARGIN_PCT`),
  set with the slider at /admin/pricing, `POST /api/v1/admin/orders/pricing` or `infernet order margin <pct>`.
- Prepaid at that price: hours x price_per_hour + setup fee. Non-compliant hours are credited or refunded
  by hand (the report shows them).
- x402: no proof = 402 with the offer (USDC on Base/Polygon/Ethereum, the crawl gateway's `COINPAY_X402_KEY` and
  `CRAWL_PAY_TO`). Retry with `X-PAYMENT`/`PAYMENT-SIGNATURE` = settled at CoinPay, the reservation is created and
  the answer carries the buyer token and a first API key. One payment fulfils one order (`payment_ref` unique).
- `pay: "checkout"`: a CoinPay checkout (any coin, PayPal) and the buyer token. The order holds its node for
  90 minutes. The CoinPay webhook or a `GET /api/v1/orders/:id` poll (which asks CoinPay itself) creates the
  reservation, exactly once (the status flip is the lock).
- The buyer token is minted with the order and is the reservation's buyer token, so the same token tracks the
  order, reads the report and invoice, and issues keys.
- Table `reservation_orders` (migration `20261027000000_reservation_orders.sql`).
- Not done: paying the node's operator its share of a prepaid order is still manual.

## Consumer GPUs on SaladCloud (2026-10-28)

Fifteen consumer-card classes (`rtx5090`, `rtx4090`, ... `rtx4060ti`) sell through the same
`POST /api/v1/orders` flow, on demand: no network node has to be online. Our cost is
SaladCloud's per-GPU-hour price at the High priority tier, effective 2026-11-01 (table in
`apps/web/lib/reservations/salad.js`), and the price is that cost times the order margin
(default 100%, so twice Salad's price: RTX 4090 $0.88/h, RTX 5090 $1.20/h).

We sell an inference service that runs on Salad, never raw Salad compute: SaladCloud's terms
(section 6, item 20) forbid reselling compute without a written agreement and allow selling
your own inference service. The buyer gets an Infernet reservation and Infernet API keys; one
Salad container group runs vLLM serving the single model they booked (an ungated Qwen 2.5 model
that fits the card), behind Salad's gateway with gateway auth off and a vLLM key only Infernet
holds.

- Paid order -> container group created stopped, reservation targets its gateway URL.
- Cron (`/api/cron/reservations`, every minute) starts it an hour before `start_at` (the setup
  fee covers that hour) and deletes it when the window ends.
- Consumer nodes can be interrupted; the per-minute probes and the existing terms (non-compliant
  hours are credited or refunded) cover that.
- Salad is prepaid. The buyer's payment arrives first; Salad credits (card, or USDC on Solana,
  $5-$10,000) have to cover the hours before the group starts. A start that fails is logged on
  the order (`error`) and refunded by hand.
- On sale only when `SALAD_API_KEY`, `SALAD_ORG` and `SALAD_PROJECT` are set; until then
  capacity lists the classes as `available: false` and orders get 503.

## Rented GPU providers (2026-11-05)

Salad was the first cloud we rent from, not the only one. Vast.ai and Thunder Compute now sell
through the same `POST /api/v1/orders` flow, and the three sit behind one registry
(`apps/web/lib/reservations/rental.js` for the pure half, `apps/web/lib/data/rental.js` for the
calls), so the cron and the order routes no longer name a cloud. Adding the next one is a row in
the registry plus an adapter pair.

What is the same for all three: we sell our own inference service, never raw compute. The buyer
gets an Infernet reservation and Infernet API keys, one model per order, and never sees a cloud
credential, a cloud URL or a shell. The price is our cost times the order margin (default 100%).

Class ids are namespaced per provider — `vast-rtx4090`, `thunder-a100` — except Salad's, which
shipped on bare card names (`rtx4090`) and keeps them.

### Vast.ai (`VAST_API_KEY`)

Seven classes (`vast-rtx3090`, `vast-rtx4090`, `vast-rtx5090`, `vast-a6000`, `vast-l40s`,
`vast-a100`, `vast-h100`), vLLM on the booked HF repo with an `--api-key` only Infernet holds.

- Vast is a **marketplace**: hosts set their own rates and there is no rate card to snapshot. So
  each class carries a **cost ceiling** — the most we will pay per GPU-hour — and the offer
  search (`POST /api/v0/bundles`) demands `dph_total <= ceiling`, verified hosts only, at least
  0.98 reliability, on-demand (never interruptible: a bid can be outbid mid-booking). The quote
  comes from the ceiling, so it is deterministic and a cheaper offer widens our margin instead of
  changing the buyer's bill. No offer under the ceiling means the class is not on sale.
- Create is `PUT /api/v0/asks/{id}` and answers `new_contract`, not `id`. `gpu_ram` is MB in the
  REST API and GB in the CLI. If `actual_status` reaches `exited`, `unknown` or `offline` the
  instance never reaches `running`: destroy and retry rather than wait out the window.
- **Transport is plain HTTP to a shared IP.** A Vast instance gets a share of a public IP with the
  container port mapped to a random external one, so there is no hostname to serve TLS for. Only
  Infernet calls it, server-side, and vLLM checks our bearer key — but the hop is unencrypted.
  The tier is marked `encrypted_transport: false`; do not sell these classes for private work.

### Thunder Compute (`THUNDER_API_TOKEN`)

Four classes (`thunder-a6000`, `thunder-l40`, `thunder-a100`, `thunder-h100`) on Thunder's stock
`ollama` template, which opens port 8000.

- `GET /v2/pricing`, `/v2/specs` and `/v2/status` need **no key**, so the rate card, the specs and
  live availability are readable before an account exists. Our snapshot is from 2026-11-05 and the
  server re-reads the live card at provision time: a class whose price has risen above the
  snapshot goes off sale rather than quietly eating the margin. Disk is billed per GB-hour on top
  of the GPU, so the 100 GB minimum ($0.03/h) is part of our cost.
- `POST /instances/create` takes only a template, GPU type, vCPUs and disk — there is no onstart
  hook or image to pass, so vLLM cannot be handed a command line here. Everything after boot goes
  over the forwarded port instead: `POST /api/pull` loads the model and `/v1` is OpenAI-compatible.
  Models are therefore Ollama tags (quantized), not HF repos.
- Ports are forwarded with `PATCH /instances/{id}/ports` on a **running** instance, and each one
  is reachable at `https://<uuid>-<port>.thundercompute.com` — so this hop is TLS, unlike Vast.
- **Ollama has no auth of its own.** Anyone who learns that hostname can spend our GPU hours. The
  uuid is never shown to the buyer and the instance lives only for the window, which is mitigation
  rather than authentication: the tier is marked `upstream_authenticated: false`. Keep the windows
  short.

### Lifecycle: rented boxes bill from the moment they exist

A Salad group can be created stopped, so it is made when the order is paid. A Vast or Thunder
instance starts billing immediately, and a booking can be 30 days out — so nothing is rented until
warm-up. The cron (`/api/cron/reservations`, every minute) drives four verbs for every provider:

| state | what happens |
| --- | --- |
| `pending` | paid, nothing rented. At `start_at - 1h` -> **rent** |
| `created` | rented or stopped. **start** (Salad) or **serve** (resolve the address, pull the model, point the reservation at it) |
| `started` | serving; nothing to do |
| `deleted` | torn down at the end of the window |

Because the address is not known until the box boots, a Vast or Thunder reservation is created
pointing at `PENDING_ENDPOINT_URL` — `https://pending.rental.invalid/v1`, a hostname that can
never resolve (RFC 2606), so a request that somehow goes out early fails closed instead of
reaching a stranger. The cron patches in the real URL (and, for Vast, the vLLM key) once the box
answers. A box that reaches a dead state is given back immediately rather than billing for the
window.

- Columns `rental_provider`, `rental_ref`, `rental_state` on `reservation_orders`
  (migration `20261105140000_rental_providers.sql`). `salad_group` / `salad_state` are kept and
  backfilled from, not dropped, so a rollback still tends live Salad orders; Salad rows keep both
  in step.
- `GET /api/v1/orders/capacity` now reports `providers[]` (which clouds are configured here and
  what is missing) and `available` per class means *orderable this minute* — account plus, where
  the provider has one, a live offer or free capacity.
- Revenue: a rented order keeps its whole total (`platform_fee.rented_orders_usd`, renamed from
  `salad_orders_usd`), because no operator is paid out of it. That figure is gross of what we pay
  the cloud — the cloud's bill is not in this ledger.
- **Neither account exists yet.** No Vast.ai or Thunder Compute credentials are in any vault, so
  both read as `available: false` and orders get 503 until a funded account's key is set. Both are
  prepaid, like Salad.
