# PRD 05: CPR receipts and reputation

Priority: **P0**

## Problem
3,351 CPR receipts are `pending` and 0 have ever been sent. Every receipt has `attempts = 0`. Reputation-weighted routing is flat because nothing writes `providers.reputation` (all 50).

## Claims being made
- "Writes CPR Receipts to coinpayportal.com on every completed job; operator reputation accumulates automatically" (/docs#architecture).
- "Use the publicKeyMultibase to verify any Receipt signed by did:web:infernetprotocol.com" (/docs#api).
- Reputation-weighted routing (README, `chat.js` header); IPIP-0007 marked Final.

## Current state (evidence)
- Receipts are built on `POST /api/v1/node/jobs/[id]/complete` and queued (`apps/web/lib/cpr/receipts.js:105-133`, `queue.js:22-74`).
- **Three independent blockers, all config or ops:**
  1. `CPR_ISSUER_API_KEY` is empty in prod `app.env`. Without it `tryFlushReceipt` returns `pending` and does not count an attempt (`queue.js:43-46`), so rows never fail and never send.
  2. Prod `CPR_API_BASE_URL=https://coinpayportal.com/api/cpr`, which is wrong: `POST /api/cpr/receipt` returns 404, `POST /api/reputation/receipt` returns 400 (verified 2026-10-06). The code default (`/api/reputation`) is right; the env overrides it.
  3. Nothing calls `/api/cron/cpr`. No crontab line, workflow schedule or pg_cron exists.
- Receipt quality: unsigned despite the DID claim, `amount` always 0, `type` always `inference` because the completion handler does not select `jobs.type` (`node-api.js:281`), buyer DID is a placeholder. NIM and RPC jobs emit no receipt.
- `did.json` advertises `/api/cpr` and `/api/v1` service endpoints; both 404.
- The daily report labels `failed` "retrying", but `failed` is terminal (`daily-stats.js`).

## Requirements
1. Register Infernet as a CPR issuer on CoinPay and put the key in the vault and prod env.
2. Remove the wrong `CPR_API_BASE_URL` from prod env (or set it to `https://coinpayportal.com/api/reputation`).
3. Add `*/2 * * * *` crontab on dev2 for `/api/cron/cpr` next to the maintenance line.
4. Before the first drain, decide what to do with the 3,351 backlog (send, or mark `skipped` for jobs older than N days).
5. Sign receipts with the DID key; select `jobs.type`; fix `did.json` service endpoints.
6. Feed CPR scores (or local completion/failure stats) back into `providers.reputation` daily so routing weights mean something.
7. Fix the report label.

## Acceptance criteria
- `cpr_receipts_queue` `sent` > 0 within an hour of enabling; pending stays under 100 in steady state.
- A receipt fetched from CoinPay verifies against `did:web:infernetprotocol.com`.
- `providers.reputation` varies across providers and changes after completions/failures.
