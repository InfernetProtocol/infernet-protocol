# PRD 13: Decentralization claims (c0mpute, P2P discovery, "control plane can go dark")

Priority: **P2** (P1 to correct the copy)

## Problem
The protocol docs say discovery and auctions run peer to peer and the network survives the control plane going dark. All routing today goes through one Supabase database on dev2.

## Claims being made
- README, INFERNET-PROTOCOL.md, INFERNET-ARCHITECTURE.md, book: c0mpute libp2p/gossipsub discovery and auctions; IPIP-0006 Phase 3+ (NIP-78, Kademlia DHT); "the control plane can go dark and nodes keep serving".

## Current state (evidence)
- No libp2p or gossipsub code in the repo; the daemon's census returns empty peers (`apps/cli/commands/start.js:1100-1130`); the c0mpute plugin installer is not in this repo.
- `/api/peers` is public and empty.
- Jobs are created and assigned only by `createChatJob` against Supabase.

## Requirements
1. Rewrite the claims as roadmap with the IPIP numbers, today.
2. If pursued: a minimal peer-to-peer path where a client can reach a node it already knows (by pubkey and address) without the control plane, with signed receipts reconciled later.

## Acceptance criteria
- No page states a P2P capability that has no code path; each roadmap item links its IPIP and status.
