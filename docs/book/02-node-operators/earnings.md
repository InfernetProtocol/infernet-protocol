# Earnings

## How earnings work

Every job your node completes is credited to it in the **earnings ledger**: one row per job, per node that worked on it. What a job earns depends on how it was paid for.

**Paid jobs.** A client opens a CoinPay invoice for the job's `payment_offer`. Your node earns its share of that payment after the 2% house fee (you keep 98%). The credit shows as *awaiting client payment* until CoinPay confirms the payment, then *confirmed*. A pipeline-parallel job served by several nodes is split the same way its Compute Payment Receipts are: the primary takes `1 / (n + 1)` for orchestration and the rest is weighted by the number of layers each slice served.

**Free jobs.** The public `/chat` playground and other unpaid traffic carry no client payment. During the alpha that is all of the traffic, so the house pays a **subsidy per 1,000 output tokens** for it. Subsidy credits show as *pending approval* until the subsidy rate is approved; after that they become *confirmed* at the rate recorded on each job. Jobs completed before the ledger existed (October 2026) were credited retroactively at the same rate.

Output tokens come from the `token_count` your daemon reports when it completes a job. For older daemons and pipeline-parallel jobs that only return text, the control plane estimates about four characters per token.

Short chat replies earn fractions of a cent. The dashboard and the CLI show amounts below one cent to six decimals, so a real credit never reads as `$0.00`.

## You do not need a payout address to earn

Earnings accrue from your first completed job whether or not you have set a payout address. The address is only needed when you withdraw.

## Checking your balance

```bash
infernet status
```

```
Earnings:   $0.0042 pending approval, $0.00 awaiting client payment, $0.00 confirmed
Payouts:    $0.00 paid, $0.00 requested, $0.00 available to withdraw
Jobs:       9 credited
```

For the per-job ledger, your withdrawals and your payout addresses:

```bash
infernet payout list
infernet payout list --json
```

The dashboard (`/dashboard`) shows the same numbers per node, with a **Withdraw** button, and every job row shows what it earned. Your node's public page (`/nodes/<id>`) shows its totals too, unless you made the node private in `/settings`.

The balance is:

```
available = confirmed earnings - (paid out + withdrawals waiting)
```

## Setting your payout address

```bash
infernet payout set <COIN> <ADDRESS> [--network <name>]
```

Supported coins are BTC, BCH, ETH, SOL, POL, BNB, XRP, ADA, DOGE, plus USDT on Ethereum, Polygon and Solana and USDC on Ethereum, Polygon, Solana and Base. The first network listed for a coin is the default, so USDC and USDT go to Ethereum unless you pass `--network`:

```bash
infernet payout set USDC 0xYourAddress --network polygon
infernet payout set SOL YourSolanaAddress
```

The newest address you set becomes the default.

## Withdrawing

```bash
infernet payout request               # the whole available balance
infernet payout request --amount 10   # part of it
```

A withdrawal needs a confirmed balance at or above the minimum (shown by `infernet payout list`) and a payout address. You can have one request open at a time. Requests are reviewed by the Infernet team and then sent through CoinPay to the address that was your default when you asked; changing the address afterwards does not redirect a request that is already waiting. When it is sent, `infernet payout list` shows the transaction hash.

## Which nodes get paid jobs

Jobs are routed by model, not by GPU brand. Any online node that serves the requested model can be picked, including older cards running small models. Serving popular models that fit your VRAM and staying online is what gets a node picked. Paid demand is still to come in the alpha; until it does, free jobs earn the subsidy.

## Payment security

Credits are tied to the node that completed the job: the completion call is signed with your node's key, and a job can only be completed by the node it was assigned to. Withdrawals go only to the default address on file when the request was made, and only after review.

Keep your node's private key safe and backed up. If you lose it you need to register a new node, and the old node's balance has to be moved by hand.
