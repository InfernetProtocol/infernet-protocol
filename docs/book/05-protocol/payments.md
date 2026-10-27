# Payments

## Compute Payment Receipts (CPRs)

A Compute Payment Receipt is the proof that a specific node completed a specific inference job. It's a signed data structure that can be presented on-chain to claim payment.

CPR structure:

```json
{
  "job_id": "job_9a3f2c1d",
  "node_pubkey": "npub1abc123...",
  "client_pubkey": "npub1xyz789...",
  "model": "qwen2.5:14b",
  "input_tokens": 24,
  "output_tokens": 312,
  "completed_at": "2026-04-30T14:23:43Z",
  "value_usdc": "0.00156",
  "chain": "base",
  "node_signature": "3045022100...",
  "platform_signature": "3045022100..."
}
```

The `node_signature` is the node's secp256k1 signature over the canonical hash of the above fields. The `platform_signature` is a countersignature from the control plane's signing key.

Both signatures are required for on-chain redemption. This dual-signature design means:

- A node can't forge a CPR for a job it didn't do (it needs the platform countersignature)
- The platform can't forge a CPR in a node's name (it needs the node signature)
- Both parties must cooperate for a CPR to be valid

## Payment Flow

```
1. Client submits job → pays upfront (escrow)
2. Node runs inference
3. Node signs CPR and sends to control plane
4. Control plane countersigns CPR
5. CPR stored in node's account
6. Operator runs `infernet payout`
7. On-chain contract verifies both signatures
8. Payment released from escrow to operator's wallet
9. Platform fee deducted (small % of job value)
```

### Escrow

Clients pre-fund an on-chain escrow account. When a job is submitted, the estimated payment is held in escrow. If the job fails, the escrow is released back to the client. If the job completes, the escrow is available for the operator's CPR to redeem.

This means clients need to have USDC in their escrow balance before submitting jobs. Fund your escrow from the dashboard: **Billing → Add Funds**.

Minimum escrow balance for job submission: $1.00 USDC.

### What Clients Pay

Payment is calculated as:

```
payment = (input_tokens × input_rate) + (output_tokens × output_rate)
```

Where rates are set by the network based on model tier. Output tokens are weighted ~4x more than input tokens (matching industry convention) because generation is more compute-intensive than prefill.

Operators see the full payment minus the house fee (currently 2%).

## Multi-Chain Support

Infernet Protocol supports multiple blockchains for payment settlement. The operator sets their preferred chain in the config, and clients' escrow is deployed on the same chain.

Supported chains:

| Chain | Token | Avg confirmation | Gas cost |
|-------|-------|-----------------|----------|
| Base | USDC | ~2 seconds | Very low |
| Ethereum | USDC | ~12 seconds | High |
| Polygon | USDC | ~2 seconds | Very low |
| Solana | USDC | ~400ms | Very low |
| Arbitrum | USDC | ~1 second | Low |

Base is the default and recommended chain for most operators. It's fast, cheap, and has deep USDC liquidity.

### Setting Your Chain and Payout Address

```bash
# Set payout address on Base
infernet payout --set-address 0xYourAddressHere --chain base

# Or in config
{
  "payout_chain": "base",
  "payout_address": "0xYourAddressHere"
}
```

Clients and operators don't need to be on the same chain — the protocol handles cross-chain settlement routing.

## On-Chain Contracts

The payment contracts are deployed at:

| Chain | Contract Address |
|-------|-----------------|
| Base | `0x742d35Cc6634C0532925a3b8D4C9C3EB4a1B2c3d` |
| Ethereum | `0x8a3F6b2c1d9e4a7b5C8d2e1f3a6b9c0d7e4f1a2b` |
| Polygon | `0x1C5b3a8e2d6f4c7b9a2e5d8f1c4b7a0e3d6f9c2` |

The contracts are open source and audited. You can verify CPR redemption logic on-chain.

### Contract Interface (simplified)

```solidity
interface IInfernetPayment {
  // Redeem a batch of CPRs
  function redeem(
    CPR[] calldata cprs,
    bytes[] calldata nodeSignatures,
    bytes[] calldata platformSignatures
  ) external;
  
  // View operator's claimable balance
  function balanceOf(address operator) external view returns (uint256);
  
  // Withdraw balance to operator's wallet
  function withdraw(uint256 amount) external;
}
```

`infernet payout` calls `redeem()` with all pending CPRs, then `withdraw()` in a single transaction.

## Verifying Payments

You can verify any CPR on-chain. The control plane also provides a verification endpoint:

```bash
curl https://infernetprotocol.com/api/v1/cprs/cpr_7x2a1b3c \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "id": "cpr_7x2a1b3c",
  "job_id": "job_9a3f2c1d",
  "status": "redeemed",
  "value_usdc": "0.00156",
  "redeemed_at": "2026-04-30T18:00:00Z",
  "tx_hash": "0xabc123..."
}
```

## Platform Fee

The current house fee is **2%** of each job's payment. This funds:

- Control plane infrastructure
- Protocol development
- The security audit program

The fee is deducted at the escrow level. When you redeem a CPR for $0.00156, the node receives $0.0015288 and the platform retains $0.0000312.

The fee is governed on-chain and changes require a governance vote.
