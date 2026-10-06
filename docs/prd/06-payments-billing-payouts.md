# PRD 06: Payments, billing and payouts

Priority: **P0 to resolve the claim** (business decisions required), P1 to build

## Problem
The homepage sells "earn crypto for every job your hardware completes" and "pay in any chain you want". Nothing is charged, nothing is paid. 0 payment transactions exist. 11 operators have registered payout addresses that will never receive anything.

## Claims being made
- "Earn crypto for the GPU you already have ... The control plane routes paying jobs to you and pays out" (/, /getting-started).
- "Pay in any chain you want ... BTC, ETH, SOL, USDC on multiple chains, Lightning" (/); coin list on /faq.
- "the matchmaking, escrow, reputation (CPR), and payment routing" (/, /llms.txt); /terms §4 says "We ... do not act as an escrow".
- CLI: `infernet payout set`, `infernet payments`; Lightning `--provision`; generated BIP39 wallets delivered to a PGP key (/docs).
- "No platform spread above market gateway fees" (/faq, /terms).
- /careers: sales roles with "$1.5K/mo to $20K/mo" deals.

## Current state (evidence)
- Every chat job is created with `payment_offer: 0` (`apps/web/lib/data/chat.js`). The completion handler writes an outbound `payment_transactions` row only when the offer is above 0 (`node-api.js:301-320`). Real traffic writes none.
- `POST /api/payments/invoice` has **no auth and no caller** in the web UI, SDK or CLI.
- `packages/payments/src/coinpayportal.js:8-11` says its API shape "is not verifiable from this sandbox"; it calls `api.coinpayportal.com/v1/invoices` with `x-api-key`, which does not match the repo's working CoinPay bot (`.github/workflows/coinpay.yml`: coinpayportal.com + business id).
- `COINPAYPORTAL_API_KEY` and `COINPAYPORTAL_WEBHOOK_SECRET` are empty in prod. The webhook 500s without the secret.
- No payout sender exists. `provider_payouts` is an address book (11 rows: BTC, ETH, SOL, USDC eth/polygon, USDT polygon). No Lightning, no generated wallets, no escrow.
- `infernet payout set` docs are wrong in both places: /getting-started's `--coin/--address ... --network arbitrum` is rejected; /docs's `BTC mainnet <addr>` saves "mainnet" as the address (`apps/cli/commands/payout.js:63-90`). No address validation.

## Open decisions (Anthony)
These change pricing, payouts or business terms and are not engineering calls:
1. **Pricing model:** per 1M tokens, per request, or operator-set prices with a market. Free tier size.
2. **Take rate:** the docs promise "no platform spread". Keep that, or charge a fee?
3. **Who holds funds:** prepaid credits held by Infernet (custodial balance, contradicts "not an escrow" in /terms), CoinPay escrow per job, or direct client-to-operator payment.
4. **Payout schedule and minimums**, and which coins/chains to actually support at launch (the site lists 9 coins + stablecoins on 4 chains + Lightning).
5. **Until decided:** change the site copy to "payments coming soon", or keep it? (Recommended: change it now; the claim is false today.)

## Requirements (once decided)
1. API keys and accounts (PRD 07) so usage can be attributed.
2. Metering: tokens per job, per key, per provider.
3. Client funding via CoinPay invoices using the verified CoinPay API; authenticated invoice route.
4. Provider earnings ledger and a payout job that sends to `provider_payouts` addresses, with address validation per chain.
5. Fix `infernet payout set` docs and add validation; implement `payout remove` or drop it from docs.
6. Remove Lightning, generated-wallet and escrow claims unless built.

## Acceptance criteria
- A paid request creates an inbound transaction; the serving provider's ledger increases by the decided share; a payout run sends on-chain and records the tx hash.
- `infernet payout set BTC mainnet x` is rejected with a usage error.
