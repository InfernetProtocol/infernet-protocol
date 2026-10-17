# Infernet Protocol media and reference kit

Infernet Protocol is an open-source decentralized GPU inference marketplace. GPU providers can run a local node, register with a hosted or self-hosted control plane, and accept inference jobs. Nodes authenticate with Nostr/secp256k1 signed HTTP requests instead of carrying database credentials.

## Canonical URLs

- Official site: https://infernetprotocol.com
- Protocol landing page: https://infernetprotocol.com/protocol
- GitHub repository: https://github.com/infernetprotocol/infernet-protocol
- Releases: https://github.com/infernetprotocol/infernet-protocol/releases
- Docker provider image: https://github.com/orgs/InfernetProtocol/packages
- Protocol spec: https://github.com/infernetprotocol/infernet-protocol/blob/master/INFERNET-PROTOCOL.md
- Architecture: https://github.com/infernetprotocol/infernet-protocol/blob/master/INFERNET-ARCHITECTURE.md
- IPIPs: https://github.com/infernetprotocol/infernet-protocol/tree/master/ipips
- Contact: protocol@infernetprotocol.com

## Short description

Infernet Protocol is an open-source decentralized GPU inference marketplace for renting, operating, and coordinating GPU capacity across cloud, edge, and self-hosted machines.

## Longer description

Infernet Protocol connects GPU providers, model operators, and inference consumers through a self-hostable control plane, signed node APIs, crypto-native payments, and a provider runtime that can run on cloud GPUs, home labs, and edge machines. The hosted control plane is available at https://infernetprotocol.com, while the codebase is published at https://github.com/infernetprotocol/infernet-protocol.

## Technical facts

- Open-source monorepo for the web dashboard, CLI, daemon, SDK packages, Docker provider image, and protocol documents.
- Next.js control plane with Supabase-backed data APIs.
- GPU nodes authenticate with Nostr/secp256k1 signed HTTP requests.
- Node configs do not need Supabase service-role credentials.
- Provider nodes can run via one-line install, Docker, or manual git clone.
- IPIP process tracks protocol improvement proposals.
- Multi-coin payment flows are designed around CoinPayPortal.

## Install snippets

```bash
curl -fsSL https://raw.githubusercontent.com/infernetprotocol/infernet-protocol/master/install.sh | sh
```

```bash
docker run --rm -it --gpus all ghcr.io/profullstack/infernet-provider:latest
```

```bash
git clone https://github.com/infernetprotocol/infernet-protocol.git
```

## Book, Discord, and third-party coverage

Add stable public URLs here when available:

- Book: https://infernetprotocol.com/book
- Discord: TBD
- Independent articles: TBD
- Interviews/podcasts: TBD
- Package index pages: TBD

These links should point to public, durable resources that can be cited by downstream directories, search engines, package indexes, and neutral encyclopedia-style summaries.
