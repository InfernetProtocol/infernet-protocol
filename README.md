<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo.infernet.white.svg">
    <source media="(prefers-color-scheme: light)" srcset="./assets/logo.infernet.black.svg">
    <img alt="Infernet Protocol" src="./assets/logo.infernet.black.svg" width="520">
  </picture>
</p>

# Infernet Protocol

A decentralized GPU compute marketplace for **inference and distributed training**, running as a workload plugin on top of [**c0mpute**](https://c0mpute.com). Rent a GPU anywhere, install c0mpute, add the infernet plugin, start earning crypto. The control plane is a Next.js dashboard; GPU nodes authenticate with **Nostr-signed HTTP requests** — they never hold a database credential, run as an unprivileged user, and can operate outbound-only. Scales horizontally — every new provider on the network is real, additional capacity.

**Infernet runs on c0mpute.** The peer discovery + auction substrate (libp2p Kad-DHT + gossipsub) lives in c0mpute, shared with other workload plugins (transcode, etc.). Infernet contributes the AI-specific layer: federated inference (llama.cpp RPC), the chat / completions API, the routing logic, and the Nostr-keyed identity model.

**What we are, what we aren't.** Infernet is the economic substrate for inference jobs that don't need NVLink — single-GPU inference (7B–70B), embarrassingly parallel batch (embeddings, image grids, sweeps), LoRA fine-tunes, and async / federated distributed training (DiLoCo-style). We don't try to match hyperscalers on tight-sync 100B+ training from scratch — that workload's interconnect moat is real and conceding it costs us nothing. The dominant inference market is request-level parallel, where per-job latency is dominated by GPU compute, not network hops. As inference ASICs (Apple Neural Engine, Qualcomm Hexagon, Tenstorrent, Groq, Cerebras, AWS Trainium) commoditize the silicon, the protocol layer is what stays valuable. Bitcoin's real lesson: the protocol survived three hardware generations because it didn't depend on any of them.

[![Docker image](https://img.shields.io/badge/ghcr.io-infernet--provider-blue?logo=docker)](https://github.com/orgs/InfernetProtocol/packages)
[![Release](https://img.shields.io/github/v/release/infernetprotocol/infernet-protocol)](https://github.com/infernetprotocol/infernet-protocol/releases)

Canonical links:
- Site: https://infernetprotocol.com
- Protocol landing page: https://infernetprotocol.com/protocol
- GitHub: https://github.com/infernetprotocol/infernet-protocol
- Media/reference kit: [docs/MEDIA_KIT.md](./docs/MEDIA_KIT.md)
- Book: https://infernetprotocol.com/book
- Protocol spec: [INFERNET-PROTOCOL.md](./INFERNET-PROTOCOL.md)
- Architecture: [INFERNET-ARCHITECTURE.md](./INFERNET-ARCHITECTURE.md)
- IPIPs: [ipips/](./ipips)
- Contact: protocol@infernetprotocol.com

---

## Getting started

Two lines on Linux, macOS, or Windows (WSL2):

```bash
# 1. Install c0mpute (the p2p substrate; brings in mise, bun, ffmpeg)
curl -fsSL https://c0mpute.com/install.sh | sh

# 2. Add the infernet plugin (installs the infernet CLI + daemon)
c0mpute plugin install infernet
```

The first command sets up c0mpute itself — peer discovery, the
gossipsub auction layer, capability registry, and the toolchain
(mise + bun) that plugins share. The second pulls
`https://c0mpute.com/plugins/infernet/install.sh` which lays down the
`infernet` CLI at `~/.local/bin/infernet` and registers infernet as
the AI-inference workload type on the c0mpute network.

### Windows (WSL2)

The CLI itself is POSIX shell, so Windows operators run it inside
WSL2 and the daemon picks up the GPU through Microsoft's WSL CUDA
driver path:

1. Enable WSL2 + install Ubuntu — `wsl --install -d Ubuntu` from PowerShell, reboot.
2. Install the Windows NVIDIA driver (gives WSL CUDA support — no driver inside WSL).
3. Open Ubuntu and run the same one-liner above.

Outbound poll for chat + remote model commands works as-is. Direct
P2P inbound on `:46337` requires a `netsh interface portproxy` rule on
the Windows host (skip it if you only care about earning via routed
jobs — the control plane handles that path outbound-only).

Then:

```bash
infernet setup           # interactive: installs Ollama, pulls a model,
                         # opens the firewall (sudo), saves config
infernet chat "hi"       # local inference, no control plane needed
infernet model list      # see what's pulled
infernet tui             # live dashboard (q to quit)
infernet help            # full command list
```

### Other install paths

| Method | Command | Status |
| --- | --- | --- |
| **c0mpute plugin** (above) | `c0mpute plugin install infernet` | ✅ works today |
| **Direct plugin URL** | `curl -fsSL https://c0mpute.com/plugins/infernet/install.sh \| sh` | ✅ works today (same script) |
| **Docker** | `docker run --rm -it --gpus all ghcr.io/profullstack/infernet-provider:latest` | ✅ works today |
| **Manual git clone** | `git clone … && pnpm install && node apps/cli/index.js` | ✅ works today |
| **npm global** | `npm install -g @infernetprotocol/cli` | 🚧 blocked on npm token regen |
| **Homebrew** | `brew install infernet` | 🚧 unblocks when npm does |

### Uninstall

```bash
c0mpute plugin uninstall infernet     # removes the infernet CLI + daemon
rm -rf ~/.config/infernet              # also removes node identity + saved config
```

(Or, to remove c0mpute entirely: `c0mpute uninstall --purge`.)

---

## What you get

- **Next.js 16 + React 19** web dashboard. Also ships as the Electron desktop app (same app, Electron wrapper).
- **Public chat playground** at `/chat` — streams tokens via Server-Sent Events. Uses live P2P providers if any are online; otherwise falls back to **NVIDIA NIM** ([build.nvidia.com](https://build.nvidia.com/)) so the demo never breaks.
- **One-click GPU deploy** at `/deploy` — mint a 24h bearer, paste the one-liner into your provider's user-data field, the box auto-detects platform + volume + GPU, installs the right engines, registers, and starts heartbeating.
- **Multi-engine inference** — pluggable adapter (IPIP-0009) over Ollama (any GPU + Apple Silicon + CPU), vLLM (NVIDIA, high-throughput), Mojo+MAX (experimental), and stub. install.sh provisions whatever the detected hardware can run.
- **Ray cluster support** — vLLM's tensor + pipeline parallelism via Ray for multi-GPU and multi-node serving. Single-box multi-GPU works without config; multi-node uses `INFERNET_RAY_MODE=head|worker` env vars.
- **Workload classes (IPIP-0010)** — A (single GPU, real-time), B (provider's cluster, real-time), B.5 (cross-provider pipeline-parallel via Petals, batch only), C (distributed training via OpenDiLoCo / OpenRLHF / Hivemind, async).
- **Training orchestration scaffold** — `@infernetprotocol/training` package with backends for DeepSpeed (Class B), OpenRLHF (Ray + vLLM rollouts + DeepSpeed updates), OpenDiLoCo (Class C), Petals (Class B.5 fine-tunes), and stub. See IPIP-0011.
- **Batch job decomposition (IPIP-0013)** — `POST /api/v1/jobs/batch` splits one logical job (embed N docs, classify N items) into chunks fan-out across providers. BullMQ default queue, Postgres-queue fallback.
- **`infernet` CLI** — one binary per GPU server. Subcommands: `init`, `login`, `register`, `update`, `remove`, `start`, `stop`, `status`, `stats`, `logs`, `payout`, `payments`, `gpu`, `firewall`, `chat`, `tui`, `model`, `setup`, `service`, `doctor`. Daemon has a local IPC socket for live queries + a **direct P2P chat transport on TCP 46337** (dual-stack IPv4/IPv6) for streaming inference between consumer and provider. **Peer discovery + workload auction live in c0mpute** (libp2p Kad-DHT + gossipsub) — infernet doesn't run its own DHT anymore.
- **Supabase** backend on the server — Postgres + Auth + Realtime. Self-hosted or cloud.
- **Nostr-signed node API** at `/api/v1/node/*` — GPU nodes sign every request with their secp256k1 / BIP-340 keypair; the control plane verifies the signature before touching the DB. No service-role keys ever leave the server.
- **Privacy-preserving telemetry** — heartbeats carry only coarse GPU capability (vendor + VRAM tier). No hostname, platform, CPU model, or RAM total is stored.
- **Multi-coin payments** via CoinPayPortal — BTC, BCH, ETH, SOL, POL, BNB, XRP, ADA, DOGE, plus USDT/USDC on ETH/Polygon/Solana/Base.
- **GPU auto-detect** — nvidia-smi, rocm-smi, Apple Silicon; stashed in `providers.specs.gpus` for control-plane job matching.
- **Host-agnostic install** — c0mpute's `install.sh` scans `df`, finds the biggest writable volume that isn't the root overlay, and symlinks the shard data dir onto it. Works for RunPod `/workspace`, Vast.ai `/data`, Lambda `/lambda`, bare metal `/mnt/*`, anywhere. Inherited by every plugin including infernet.

## Security & anonymity model

Design goals: a GPU node should be able to run as an unprivileged user, leak as little as possible about its host, and never hold a credential that could compromise the rest of the network.

- **No database credential on nodes.** The CLI holds a Nostr (secp256k1 / BIP-340 Schnorr) keypair and nothing else. The control plane is the only thing that talks to Supabase; nodes talk to the control plane over `/api/v1/node/*` with a signed envelope on every request.
- **Signed-request envelope.** Each call carries `X-Infernet-Auth: base64url({ v, pubkey, created_at, nonce, sig })` where `sig` is a Schnorr signature over `METHOD + path + created_at + nonce + sha256(body)`. 60-second replay window, per-process nonce cache, pubkey must match `public_key` on the target row.
- **Minimized telemetry.** Heartbeats carry only coarse GPU capability: `{ vendor, vram_tier, model }` per GPU. Hostname, platform, arch, CPU model, RAM total are discarded both client-side and at the server sanitizer.
- **Outbound-only mode.** Pass `--no-advertise` to `init` / `register` / `start` and the node never publishes an IP or port; it only pulls work via signed polls. Pairs naturally with Tor or a NAT.
- **Unprivileged install.** Config lives at `~/.config/infernet/config.json` (mode 0600). No `/etc`, no `/var`, no sudo, no privileged ports (default P2P port 46337, override with `--p2p-port`).
- **Auto-migration.** Legacy configs that still carry `supabase.serviceRoleKey` are stripped silently on load — the field never gets re-saved to disk.

## Deployment modes

The control plane runs one of two ways:

1. **Self-hosted** — run Supabase yourself via the Supabase CLI (`supabase start`). Best for privacy and offline development.
2. **Infernet cloud** — point the CLI at the hosted control plane at `https://infernetprotocol.com`. Rent a GPU anywhere, `infernet init`, start earning.

Operators can point **many GPU nodes at the same control plane** — each node has its own Nostr identity and shows up as its own row in the dashboard.

---

## Zero-touch install

One block, zero ssh, no manual `infernet setup` afterwards. Mint a 24h
bearer at [/deploy](https://infernetprotocol.com/deploy), then on the
target box:

```sh
curl -fsSL https://c0mpute.com/install.sh | sh
INFERNET_BEARER=$TOKEN INFERNET_MODEL=qwen2.5:7b \
  c0mpute plugin install infernet
```

What it does: c0mpute's installer detects platform, installs mise +
bun + ffmpeg, lays down the `c0mpute` binary, and (by default) symlinks
the shard data dir onto the biggest writable volume. The plugin
installer then drops the `infernet` CLI, runs `infernet init` +
`login --token` + `setup --yes` + `start` so the node registers,
heartbeats, and starts taking jobs in one shot.

For RunPod / DigitalOcean / AWS / bare-metal cloud-init, paste both
lines into the platform's "user data" or "container start command"
field. Works in any Linux box with `curl` and root.

### Reachability note

The control-plane-mediated chat path **does not need inbound connectivity**
— the daemon polls and posts outbound. Port 46337 only matters if you
want the direct P2P chat transport (consumer dials provider for low-latency
streaming). Residential operators behind NAT can skip port forwarding and
still earn.

---

## Architecture (one page)

```
       ┌────────────────────────────────────────────────┐
       │   Next.js dashboard (self-hosted OR cloud)     │
       │   /chat · /deploy · /api/* · SSE streaming     │
       │   /api/v1/node/* — signature-verified endpoints│
       └───────────────────────┬────────────────────────┘
                               │  (server-side only)
                               ▼
       ┌────────────────────────────────────────────────┐
       │                  Supabase                      │
       │  providers · clients · aggregators · jobs      │
       │  users · job_events · platform_wallets         │
       │  provider_payouts · payment_transactions       │
       └────────────────────────────────────────────────┘
                               ▲
        Nostr-signed HTTP      │        anon / SSE
        (BIP-340 Schnorr)      │
   ┌────────────┐   ┌──────────┐   ┌─────────────────┐
   │ infernet   │…  │ Expo app │   │ NVIDIA NIM      │
   │ CLI daemon │   │          │   │ (fallback only) │
   │ P2P:46337  │   └──────────┘   └─────────────────┘
   │ IPC sock   │
   └────────────┘
```

The GPU node holds a Nostr keypair (generated on `infernet init`); every
call to the control plane carries an `X-Infernet-Auth` envelope with a
Schnorr signature over method + path + timestamp + nonce + sha256(body).
The server enforces that the signing pubkey owns the target row. No DB
credential ever lives on the node.

Full detail: [INFERNET-ARCHITECTURE.md](./INFERNET-ARCHITECTURE.md).

---

## Stack

- Node.js 18+, ESM only, **pnpm workspaces** monorepo (5 apps, 11 shared packages)
- Next.js 16.x (App Router), React 19, Tailwind CSS
- Supabase (`@supabase/supabase-js`)
- Vitest for tests
- Electron for the desktop shell
- React Native + Expo for mobile
- Docker + GitHub Actions CI/CD (multi-arch images: `linux/amd64` + `linux/arm64`)

---

## Quick start

### 1. Control plane (one-time)

Self-hosted:

```bash
pnpm install
pnpm supabase:start
pnpm supabase:db:reset   # applies all migrations in supabase/migrations/
pnpm dev                 # dashboard at http://localhost:3000
```

Or point at Supabase cloud:

```bash
pnpm install
pnpm supabase:login
pnpm supabase:link
pnpm supabase:db:push    # pushes migrations to the cloud project
pnpm dev
```

Copy `sample.env` → `.env` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the CoinPayPortal keys.

### 2. Each GPU server (Docker — the supported install path today)

```bash
docker run --rm -it \
  --gpus all \
  -p 46337:46337 \
  -e INFERNET_CONTROL_PLANE_URL=https://infernetprotocol.com \
  -e INFERNET_NODE_NAME=edge-01 \
  ghcr.io/profullstack/infernet-provider:latest
```

Multi-arch (`linux/amd64` + `linux/arm64`). The image calls `infernet init` → `infernet register` → `infernet start --foreground` internally, so one command boots a provider and starts accepting jobs. No database credentials are passed in — the container generates its own Nostr keypair on first run and uses it to sign every request.

#### Running the CLI directly

If you cloned the repo:

```bash
pnpm install
pnpm --filter @infernetprotocol/cli start -- help     # any subcommand
```

Full CLI surface: `init`, `login`, `register`, `update`, `remove`, `start`, `stop`, `status`, `stats`, `logs`, `payout`, `payments`, `gpu`, `firewall`. Config lives at `~/.config/infernet/config.json`.

npm install (`npm i -g @infernetprotocol/cli`) and Homebrew (`brew install infernet`) are on the roadmap.

`infernet init` walks through:

- Control-plane URL (default `https://infernetprotocol.com`, or your self-hosted instance)
- Node role (`provider` / `aggregator` / `client`)
- Human-readable name
- Nostr keypair — real secp256k1 / BIP-340 (auto-generated; bring your own with `--nostr-privkey`)
- P2P port (default **46337**, TCP, dual-stack IPv6/IPv4) — pass `--no-advertise` to stay outbound-only
- Auto-detected local address (override with `--address`)
- GPU detection via `nvidia-smi` / `rocm-smi` / `system_profiler`
- Firewall hint per your distro

Config lives at `~/.config/infernet/config.json` (mode 0600). It contains the node's Nostr keypair and the control-plane URL — no database credentials, no service-role keys.

---

## CLI surface

```
Node lifecycle:
  init          First-time setup (generates Nostr keypair)
  login         Re-point at a different control plane
  register      Announce this node (signed POST /api/v1/node/register)
  update        Re-push current state (signed; upsert)
  remove        Deregister and wipe local config (signed)

Daemon:
  start         Start daemon (detached; --foreground for supervisors)
  stop          Stop daemon (graceful via IPC, signal fallback)
  status        Control-plane row + live daemon snapshot
  stats         Live in-memory daemon stats via IPC
  logs          Show / tail the daemon log (-f for follow)

Diagnostics:
  gpu           Inspect local GPUs (list | json)
  firewall      Print firewall commands for the P2P port

Payments:
  payout        Manage payout coin/address (set, list)
  payments      Show recent payment transactions
```

### Daemon ↔ CLI

`infernet start` detaches into the background (logs at `~/.config/infernet/daemon.log`) and exposes a **Unix-domain IPC socket** at `~/.config/infernet/daemon.sock`. The other CLI commands use that socket for live queries:

- `infernet status` fetches this node's row from the control plane (signed POST `/api/v1/node/me`) and merges it with the daemon's in-memory snapshot.
- `infernet stats` shows heartbeat counts, poll counts, active jobs, uptime, P2P connections.
- `infernet stop` sends a graceful shutdown command; falls back to SIGTERM via the PID file.
- `infernet logs -f` tails the log file.

Use `infernet start --foreground` under systemd / Docker / Kubernetes when a supervisor wants the process in the foreground.

### P2P port

Each provider/aggregator node binds TCP **46337** (dual-stack) for peer communication. Change with `--p2p-port`, or disable with `--no-p2p`. The node advertises its `address:port` to the control plane on every signed heartbeat so other nodes can discover it — unless it was started with `--no-advertise`, in which case nothing is published and the node operates outbound-only.

Need to open the port on your firewall? `infernet firewall` prints the exact commands for ufw / firewalld / nftables / iptables (Linux), pf (macOS), or netsh (Windows). We never touch firewall state automatically.

### GPU support

The CLI auto-detects GPUs on `init`, `register`, `update`, and daemon heartbeat:

- **NVIDIA** (CUDA) via `nvidia-smi` — model, VRAM, driver, CUDA version, utilization, temperature, power.
- **AMD** (ROCm) via `rocm-smi` — same fields where available.
- **Apple Silicon** via `system_profiler` — model, unified memory.
- Falls back to CPU-only if no GPU tooling is installed.

Detected GPUs feed the coarse capability payload that lands in `providers.specs.gpus` (jsonb): `{ vendor, vram_tier, model }` per card, plus `gpu_count`. Enough to route jobs (e.g. "find me a provider in the 24-48gb tier") without broadcasting the machine's full fingerprint.

---

## NVIDIA NIM fallback

When the P2P network has no live providers, the chat playground transparently falls back to [build.nvidia.com](https://build.nvidia.com/)'s OpenAI-compatible endpoint so the UX never breaks while the network is bootstrapping. Controlled by three env vars (all optional; leave blank to disable):

```bash
NVIDIA_NIM_API_KEY=             # from https://build.nvidia.com/
NVIDIA_NIM_API_URL=https://integrate.api.nvidia.com/v1
NVIDIA_NIM_DEFAULT_MODEL=meta/llama-3.3-70b-instruct
```

Same SSE contract as the P2P path — tokens are mirrored into `job_events` so the audit trail is identical. The chat UI badges fallback responses "NVIDIA NIM (fallback)" for transparency. Adapter: [`packages/nim-adapter`](./packages/nim-adapter).

## Payments

Consumers can pay for jobs and providers can be paid out in any of these coin/network combinations:

BTC, BCH, ETH, SOL, POL, BNB, XRP, ADA, DOGE; plus USDT on ETH/Polygon/Solana; plus USDC on ETH/Polygon/Solana/Base.

- Canonical list: [`packages/config/payment-coins.js`](./packages/config/payment-coins.js)
- Platform deposit addresses: [`packages/config/deposit-addresses.js`](./packages/config/deposit-addresses.js) — also seeded into the `platform_wallets` table.
- Gateway: CoinPayPortal ([`packages/payments/src/coinpayportal.js`](./packages/payments/src/coinpayportal.js)). Set `COINPAY_API_KEY`, `COINPAY_WEBHOOK_SECRET` (and optionally `COINPAY_BUSINESS_ID`) in `.env`.
- Methods: `GET /api/payments/methods` lists every coin the CoinPay business takes, plus PayPal; `hosted: true` once CoinPay hosts checkout sessions.
- Invoice: `POST /api/payments/invoice` with `{ jobId, method }` (`USDC_POL`, `BTC`, `paypal`, ...) or `{ jobId, coin, network }`; returns `paymentUrl`. Metadata carries `property`, `account_id` (the job's client) and `email`.
- Webhook: `POST /api/payments/webhook`, verified by `X-CoinPay-Signature`; settles by the stored CoinPay id, updates `payment_transactions` + `jobs.payment_status`.

Provider earnings flow into the outbound direction of `payment_transactions`. Configure a payout wallet with `infernet payout set <COIN> <ADDRESS>`.

---

## Project layout (monorepo)

```
apps/
  web/                   Next.js dashboard + /chat + /deploy + REST/SSE API
  cli/                   The `infernet` binary (commands + daemon + IPC)
  desktop/               Electron shell wrapping the Next.js app
  mobile/                React Native + Expo app
  daemon/                Placeholder for future standalone service daemons

packages/
  config/                Payment-coin list + canonical deposit addresses
  auth/                  Nostr identity + signed-request envelope (BIP-340)
  db/                    Supabase-backed model layer (server-side only)
  gpu/                   GPU detection (NVIDIA / AMD / Apple Silicon)
  inference/             Distributed inference coordinator / worker
  payments/              CoinPayPortal gateway
  logger/                Structured logger
  sdk-js/                @infernetprotocol/sdk — REST + SSE client
  api-schema/            OpenAPI 3.1 spec for the control-plane API
  deploy-providers/      Cloud-GPU deploy adapters (RunPod today)
  nim-adapter/           NVIDIA NIM fallback inference adapter

tooling/
  docker/provider/       Dockerfile + entrypoint for ghcr.io/.../infernet-provider
  dist/homebrew/         Homebrew formula + release-time updater

supabase/migrations/     SQL schema (applied via supabase CLI)
tests/                   Vitest suite
```

---

## API routes

```
GET   /api/overview
GET   /api/nodes
GET   /api/jobs
GET   /api/providers
GET   /api/aggregators
GET   /api/clients
GET   /api/models
POST  /api/chat                            Chat playground — picks P2P provider OR NIM fallback, returns streamUrl
GET   /api/chat/stream/[jobId]             SSE: tokens streamed live (job|meta|token|done|error)
GET   /api/payments/methods                CoinPay coins + PayPal on offer
POST  /api/payments/invoice                CoinPay checkout for a job
POST  /api/payments/webhook                CoinPayPortal webhook sink (HMAC-verified)
GET   /api/deploy/runpod/gpu-types         RunPod GPU catalog (proxied via user API key; not stored)
POST  /api/deploy/runpod                   One-click launch an Infernet provider pod

Signature-verified node API (Nostr / BIP-340 Schnorr):
POST  /api/v1/node/register                Upsert a provider/aggregator/client row
POST  /api/v1/node/heartbeat               Refresh last_seen / status / address / port
POST  /api/v1/node/jobs/poll               Pull assigned jobs for this provider
POST  /api/v1/node/jobs/[id]/complete      Mark a job completed / failed + record payout row
POST  /api/v1/node/jobs/[id]/events        Batch-emit streaming tokens into job_events
POST  /api/v1/node/remove                  Deregister this node
POST  /api/v1/node/me                      Fetch this node's own row
POST  /api/v1/node/payments/list           List payment_transactions for this node
POST  /api/v1/node/payouts/{list,set}      Manage provider_payouts rows
```

Web/mobile routes are server-only — the Supabase service-role client is never imported into browser bundles. The `/api/v1/node/*` routes are the only ones nodes ever touch, and they verify a Nostr signature before any DB write. OpenAPI 3.1 spec ships as [`@infernetprotocol/api-schema`](./packages/api-schema) (raw YAML at `packages/api-schema/openapi.yaml`).

## Developer surfaces

- **`@infernetprotocol/sdk`** ([packages/sdk-js](./packages/sdk-js)) — JS/TS SDK with an `InfernetClient` and an async-iterator `chat()` helper for the SSE stream.
- **`@infernetprotocol/api-schema`** ([packages/api-schema](./packages/api-schema)) — OpenAPI 3.1 spec; feed to any generator for Python/Go/Rust clients.
- **`@infernetprotocol/deploy-providers`** ([packages/deploy-providers](./packages/deploy-providers)) — cloud-GPU adapters (RunPod today) powering the one-click `/deploy` page.

## Distribution

- **Docker** (LIVE) — `ghcr.io/profullstack/infernet-provider:0.1.0` and `:latest`, multi-arch `linux/amd64` + `linux/arm64`. One command boots a provider; see the Quick start above.
- **npm** (scaffolded, unblock pending) — 11 publishable `@infernetprotocol/*` packages (`cli`, `sdk`, `api-schema`, `deploy-providers`, `nim-adapter`, `auth`, `config`, `db`, `gpu`, `inference`, `logger`, `payments`). Release workflow + dry-run publish are ready; waiting on an npm Automation token.
- **Homebrew** (scaffolded) — formula + updater script at [`tooling/dist/homebrew`](./tooling/dist/homebrew). Tap repo at [`infernetprotocol/homebrew-infernet`](https://github.com/infernetprotocol/homebrew-infernet). Activates as soon as npm ships.

Tag a `v*.*.*` and [`.github/workflows/release.yml`](./.github/workflows/release.yml) builds the Docker image and creates a GitHub Release. See [`docs/RELEASING.md`](./docs/RELEASING.md) for the full flow.

## One-click GPU deploy

The `/deploy` page (backed by `POST /api/deploy/runpod`) spins up an Infernet provider node on RunPod using a user-supplied API key. The server proxies the RunPod API call and immediately drops the key — nothing is persisted. The pod boots the `infernet-provider` image, generates a Nostr keypair, registers itself with the control plane over a signed request, and starts heartbeating.

---

## Contributing

See [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
