# Infernet Protocol: claims on the site vs what actually ships

Audit date 2026-10-06. Repo: `712b125` (origin/master). Live: https://infernetprotocol.com (nginx/1.28.3 on 23.95.228.174, `/api/health` uptime 176035 s, `commit: null`).
Paths are relative to the repo root. "Live" means a read-only GET or a 400-returning POST. **No chat job was submitted**, because that would write a `jobs` row to prod. So the end-to-end chat result is inferred from the code, not observed.

Status key: **SHIPPED** = works as claimed · **PARTIAL** = code exists but is incomplete, unused, or empty in practice · **MISSING** = no implementation · **BROKEN** = exists but fails, is false, or contradicts reality.

## Live API snapshot (GET, 2026-10-06 ~08:30 UTC)

| Endpoint | Response |
|---|---|
| `/api/health` | `{"ok":true,"uptime_s":176035,"node_env":"production","commit":null}` |
| `/api/overview` | Online nodes **0** "of 41 registered"; Models served **33** "qwen2.5:0.5b, deepseek-coder:6.7b, qwen3:8b…"; Jobs **100** "10 pending"; Last heartbeat "-" "no heartbeats yet" |
| `/api/models`, `/api/nodes`, `/api/gpu`, `/api/cpu`, `/api/peers?limit=10`, `/api/clients`, `/api/aggregators` | `{"data":[]}` |
| `/v1/models` | `{"object":"list","data":[]}` |
| `/api/providers` | rows with `status:"available"` (e.g. Radeon Pro Vega 64, P104-100, Apple M4), all `price_display:"$0.0000"`, `reputation:50`, `cli_version:"0.1.45"` |
| `/api/jobs?limit=5` | titles `<encrypted>`, every `payment_offer:"$0.0000"`, 2 `pending` jobs for `gpt-4o-mini` |
| `/api/chat/provider` | `{"error":"No providers available"}` |
| `/api/v1/rpc/census?model=qwen2.5:7b` | `{"primaries":0,"slices":0,"min_slices":2,"ready":false}` |
| `/.well-known/did.json` | 200, Ed25519 key, services `.../api/cpr` (404) and `.../api/v1` (404) |
| `POST /v1/chat/completions {}` | 400 `{"error":{"message":"messages[] is required","type":"infernet_error","code":400}}` |
| `/api/v1/jobs`, `/api/v1/jobs/abc`, `/api/jobs/submit`, `/api/v1/jobs/batch`, `/api/cpr`, `/api/v1/models` | 404 |

---

## Inference API

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 1 | "The public endpoint is OpenAI-compatible. If you've ever called OpenAI's API, you already know how to use it." | /getting-started | inference API | PARTIAL | `apps/web/app/v1/chat/completions/route.js` handles `stream` true/false and returns OpenAI-shaped errors (live 400 above). `usage` is always zeros (route.js:211-213). Only `model, messages, stream, temperature, max_tokens` are read (route.js:71); `top_p`, `stop`, `n`, tools and so on are ignored. |
| 2 | "bring your own API key for production" / `apiKey: process.env.INFERNET_API_KEY` | /getting-started | inference API | MISSING | The route never reads `Authorization` (route.js:59-102). There is no API-key table, route or UI anywhere in `apps/web`. Every caller shares one IP limit of 20 requests/hour (route.js:30), so production use is impossible. |
| 3 | `curl .../v1/chat/completions -d '{"model":"qwen2.5:7b",...}'` "Try it in 30 seconds" | /getting-started | inference API | BROKEN (inferred) | Live: `/v1/models` is empty and `/api/chat/provider` returns "No providers available". With no provider, `createChatJob` falls back to NIM (`apps/web/lib/data/chat.js:255`). The NIM path then forwards `job.model_name` = `qwen2.5:7b` to NVIDIA (`apps/web/lib/data/chat-stream.js:143`), and that is not a NIM model id; `nim_model` is never set anywhere. Expected outcome: a NIM error, or a 503 if NIM is unconfigured. Not executed (it would write to prod). |
| 4 | OpenAI `GET /v1/models` | (implied by the SDK examples) | inference API | PARTIAL | `apps/web/app/v1/models/route.js` exists, but it lists only providers live in the last 10 minutes (`lib/data/chat.js:359-372`). Live it returns `data:[]`. |
| 5 | "Auth uses bearer tokens from the dashboard … creating an API key in the Infernet Dashboard under Settings → API Keys"; `POST /api/v1/jobs`, `GET /api/v1/jobs/:id` | /book (ch. 4, Building apps) | inference API | MISSING | Live `/api/v1/jobs` and `/api/v1/jobs/abc` both return 404. There is no `app/api/v1/jobs` route and no API-key feature. The whole developer chapter of the book documents an API that does not exist. |
| 6 | "/api/chat POST … Submit a chat job (legacy alias for /api/jobs/submit)" | /docs#api | inference API | PARTIAL | `app/api/chat/route.js` exists (GET returns 405). `/api/jobs/submit` returns 404 and has no route. |
| 7 | "/api/chat/stream/[jobId] GET (SSE) Stream tokens + events" | /docs#api | inference API | SHIPPED | Live 200 `text/event-stream`. `app/api/chat/stream/[jobId]/route.js`. |
| 8 | "the Infernet control plane exposes /v1/chat/completions as an OpenAI-compatible gateway that routes to live providers (or falls back to NVIDIA NIM if the network is empty)" | /faq | inference API | PARTIAL | Routing code: `lib/data/chat.js:37-80` (weighted pick), :255 (NIM). There are 0 live providers, so in practice every request is NIM or fails. The model-name mismatch is described in #3. |
| 9 | "/api/admin/* dashboard tier (cookie session)" | /docs#architecture | inference API | MISSING | The only admin route is `app/api/admin/me/route.js`. The docs themselves say "when those land, IPIP-0003 phase 4". |
| 10 | "Spec lands as IPIP-0013: POST /api/v1/jobs/batch … Endpoint not yet live" | /faq | inference API | MISSING (disclosed) | Live 404. No route. The page is honest about it. |
| 11 | "Submit chat, training, or embedding jobs" | / | inference API | MISSING (embeddings) | No embeddings route. Engine backends only do chat generation (`packages/engine/src/backends/*`). |
| 12 | "/.well-known/did.json Platform DID document (IPIP-0007)" | /docs#api | inference API | PARTIAL | Live 200 with an Ed25519 key. Its declared `CPRIssuer` service `https://infernetprotocol.com/api/cpr` returns 404, and `InfernetControlPlane` `/api/v1` returns 404. |
| 13 | "/api/peers?limit=N Bootstrap seed peers" → example with pubkey/multiaddr | /docs#api | inference API | PARTIAL | Route exists (`app/api/peers/route.js`). Live `{"data":[]}`. |

## Chat playground

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 14 | "Every message you send is routed to a random live GPU node running the infernet CLI. No data center in the middle" | /chat | chat | BROKEN | Live: 0 online nodes and `/api/chat/provider` returns "No providers available". The fallback is NVIDIA NIM, which is a data center (`lib/data/chat.js:255`, `packages/nim-adapter`). The homepage itself admits "falls back to NVIDIA NIM so the demo never breaks", which contradicts this /chat copy. |
| 15 | "Distribute across all nodes" checkbox | /chat | chat | PARTIAL | `app/chat/chat-view.js:466-516` gates the checkbox on `/api/v1/rpc/census`. Live census `ready:false, primaries:0`, so the checkbox is permanently disabled. |
| 16 | "Public playground, rate limited per IP. No sign-in required." | /chat | chat | SHIPPED | `lib/rate-limit` is used in `/api/chat` and `/v1/chat/completions` (20/h). |
| 17 | "tokens stream back over SSE … it's the real wire" | / | chat | SHIPPED | `app/api/chat/stream/[jobId]/route.js` (Supabase realtime → SSE). |
| 18 | E2E-encrypted prompts (NIP-44, IPIP-0027) | (not marketed; code only) | chat | PARTIAL | `app/chat/chat-view.js:140-160` encrypts only when a provider can be pre-selected. `/v1/chat/completions` and `/api/chat` without a provider store the plaintext messages (see #53). |

## Models and engines

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 19 | "Run any model you can serve, Qwen, Llama, Mistral, your own" | / | models | SHIPPED | `packages/engine/src/backends/ollama.js`, `vllm.js`, `llamacpp.js`, `sglang.js`, `max.js`, `mojo.js`. |
| 20 | Status card "Models served 33, qwen2.5:0.5b, deepseek-coder:6.7b, qwen3:8b…" | /status, /api/overview | models / stats | BROKEN | `apps/web/lib/data/infernet.js:306-312` counts `served_models` over **all** registered providers, including offline ones. On the same page, the "Models served" table reads "No models advertised", and `/v1/models` and `/api/models` are empty. |
| 21 | "Coming next: vLLM + ComfyUI endpoints. OpenAI-compatible chat/completions via vLLM" vs FAQ "on NVIDIA boxes it installs both Ollama and vLLM … Auto-select picks vLLM ahead of Ollama" | / vs /faq | models | PARTIAL (contradiction) | vLLM is already shipped: `install.sh:788-853` and `packages/engine/src/index.js:83-85`. The homepage still lists it as "coming next". |
| 22 | ComfyUI image generation | / | models | MISSING (labelled coming) | No ComfyUI code (grep finds only `app/page.js:102-103`). |
| 23 | "set INFERNET_RAY_MODE=head on one box, INFERNET_RAY_MODE=worker + INFERNET_RAY_HEAD=host:6379" | /faq | distributed inference | MISSING | `INFERNET_RAY_MODE` appears only in `apps/web/app/faq/page.js`. Nothing reads it. |
| 24 | "We support pipeline-parallel sharding across providers (Class B.5 via Petals)" | /faq | distributed inference | BROKEN (stale) | `apps/cli/commands/inference.js:16,205`: "The Petals path (IPIP-0031, Replaced) was removed." |
| 25 | "The dashboard displays a 'Visible to N relay peers' warning on B.5 submissions." | /faq | privacy | MISSING | The string exists only in `app/faq/page.js:256`. |
| 26 | `infernet --backend <kind>` "Local: ollama \| mojo \| stub" | /docs#cli-chat | models | SHIPPED | `packages/engine/src/backends/mojo.js` (needs an external `infernet-engine` binary) and `stub.js`. |
| 27 | `infernet uncensored # one-shot install of Hermes 3 / Dolphin`; `infernet model recommend --install-all` | /getting-started | models | SHIPPED | `apps/cli/commands/uncensored.js`, `apps/cli/commands/model.js:34-38,166`. |

## Nodes and providers

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 28 | Status providers table shows 4 nodes "available" while "Online nodes 0" | /status | nodes / stats | BROKEN | The providers list uses the `status` column with no `last_seen` filter, and nothing ever flips stale rows to offline. `/gpu` says "No live GPU providers in the last 10 min." on the same site. |
| 29 | "Last heartbeat, no heartbeats yet" (with 41 registered) | /status | stats | BROKEN (misleading) | `infernet.js:338-340` reads only providers seen in the last 10 minutes, so the card claims no heartbeat has ever happened. |
| 30 | "Jobs 100, 10 pending"; table titled "Queued jobs, Jobs in the queue right now" | /status | stats | BROKEN | The 100 is the `getJobs({limit:100})` cap (`infernet.js:298,333`), not a total. The "queued" table lists completed jobs. |
| 31 | "Operators authenticate with a Nostr keypair … X-Infernet-Auth envelope with a Schnorr signature over method + path + timestamp + nonce + sha256(body)" | /, /faq | nodes | SHIPPED | `packages/auth/src/signed-request.js:7-71`. |
| 32 | "never a database credential" | /, /protocol | nodes | PARTIAL | True for the CLI. But the GitHub Release v0.1.53 notes and `tooling/docker/provider/README.md:31-45` tell operators to run the provider with `SUPABASE_SERVICE_ROLE_KEY`. |
| 33 | "Peer discovery + workload auctions live in c0mpute (libp2p Kad-DHT + gossipsub) … The control plane can go dark and the c0mpute network keeps working." | /, /llms.txt | nodes / distributed | MISSING | `apps/cli/commands/start.js:1100-1130`: the census "always returns count: 0 … until the c0mpute-backed query is wired in". All routing goes through the control-plane DB (`lib/data/chat.js:37`). The c0mpute "infernet plugin" (`c0mpute.com/plugins/infernet/install.sh`) only `exec`s `infernetprotocol.com/install.sh`. There are no auctions. |
| 34 | "Does my GPU node need a public IP? No … outbound-only"; `--no-advertise` | /faq, /docs | nodes | SHIPPED | Poll model: `app/api/v1/node/jobs/poll`, `apps/cli/commands/start.js:74,132`. |
| 35 | "from the dashboard's 'Push model' UI (or via POST /api/v1/user/nodes/<pubkey>/commands)" | /faq | nodes | PARTIAL | The API exists (`app/api/v1/user/nodes/[pubkey]/commands/route.js:80`) and the daemon handles `model_install`. There is no Push-model UI in `app/dashboard/page.js`. |
| 36 | Interconnect detection and advertisement (NVLink/xGMI/IB/EFA) | /docs#interconnects | nodes | SHIPPED | `packages/gpu/src/interconnect.js`, `apps/cli/commands/register.js:156,214`. |
| 37 | "When the daemon launches an engine for a job, it merges the output of interconnectEnv(capability) into the child's environment" (NCCL_IB_HCA, FI_PROVIDER…) | /docs#interconnects | nodes | MISSING | `interconnectEnv` is defined in `packages/gpu/src/interconnect.js:335` and is never imported by `apps/` (grep finds only `apps/web/app/docs/page.js`). |
| 38 | "Infernet is the protocol layer … reputation (CPR)" | / | nodes | PARTIAL | Every provider shows `reputation: 50` (the default) on `/api/providers`. |

## Payments and payouts

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 39 | "Earn crypto for the GPU you already have … The control plane routes paying jobs to you and pays out" / "start earning crypto for every job your hardware completes" | /, /getting-started | payments | MISSING | Chat jobs are created with `payment_offer: 0` (`lib/data/chat.js:282`). On completion a `payment_transactions` row is written only when amount > 0, with `address: "pending-payout"` and status `pending` (`lib/data/node-api.js:302-316`, comment: "payment accounting is follow-up work"). No code sends a payout (grep for payout/disburse finds nothing). Every live job and provider shows $0.0000. |
| 40 | "Pay in any chain you want … BTC, ETH, SOL, USDC on multiple chains, Lightning" | / | payments | PARTIAL | `app/api/payments/invoice/route.js` + `packages/payments/src/coinpayportal.js:175` can invoice a job with a `payment_offer`. No user flow ever sets an offer. Lightning is not in `packages/config/payment-coins.js`. |
| 41 | "BTC, BCH, ETH, SOL, POL, BNB, XRP, ADA, DOGE; plus USDT on ETH/Polygon/Solana; plus USDC on ETH/Polygon/Solana/Base" | /faq | payments | SHIPPED (config) | `packages/config/payment-coins.js:12-27` matches exactly. |
| 42 | `infernet payout set --coin BTC --address bc1q...` / `--coin USDC --address 0x... --network arbitrum` | /getting-started | payments | BROKEN | `apps/cli/commands/payout.js:63-67` requires positional `<coin> <address>`, so the flag form prints usage and exits 1. `arbitrum` is not a supported network (payout.js:76-82). |
| 43 | `infernet payout set BTC mainnet bc1q9h6…` (and ETH/SOL "mainnet") | /docs#cli-payout | payments | BROKEN | Parsed as coin=BTC, **address="mainnet"** (payout.js:63, 90). There is no address validation, so it silently saves "mainnet" as the payout address. |
| 44 | `infernet payout set BTC ln lno1…` (bolt12) and `--provision` custodial LN channel | /docs#cli-payout | payments | MISSING | No Lightning code (grep for `provision` in the CLI finds only `deploy.js`). |
| 45 | "operators who don't [have wallets] can have a non-custodial BIP39 wallet generated and the encrypted seed phrase delivered to their PGP key" / "BYO wallet or generated" | /docs, / | payments | MISSING | No bip39, mnemonic or pgp code in `apps/cli`. |
| 46 | `infernet payout remove ETH mainnet` | /docs#cli-payout | payments | MISSING | The switch handles only `list` and `set` (payout.js:115-124). |
| 47 | `infernet payments # recent transactions (signed read)` | /docs, /faq | payments | SHIPPED | `apps/cli/commands/payments.js`, `app/api/v1/node/payments/list`. It will always be empty. |
| 48 | "Payouts batch into provider_payouts rows" | /faq | payments | PARTIAL | The table holds payout addresses (`app/api/v1/node/payouts/set`). There is no batching or settlement job. |
| 49 | "the matchmaking, escrow, reputation (CPR), and payment routing" | /, /llms.txt | payments | MISSING / contradicted | No escrow code (the only hit is a field name, `lib/cpr/receipts.js:126 escrow_tx`). /terms §4 says "We … do not act as an escrow." |
| 50 | "There's no platform spread above market gateway fees" | /faq, /terms | payments | N/A | Unverifiable, because nothing is charged. |
| 51 | Sales Engineer: "Deal sizes range from $1.5K/mo … to $20K/mo"; "financed deals" | /careers | payments | MISSING (capability) | There are no client accounts, API keys, metering or billing to sell (#2, #5, #39). |

## CPR receipts

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 52 | "Writes CPR Receipts to coinpayportal.com on every completed job, operator reputation accumulates automatically." | /docs#architecture | CPR | PARTIAL | `lib/data/node-api.js:323-347` → `lib/cpr/queue.js`, `lib/cpr/cpr-client.js` (default `https://coinpayportal.com/api/reputation`), drained by `app/api/cron/cpr`. It is fire-and-forget, the amounts are always 0, and nothing on the CoinPay side was verified. Live reputation stays at 50 for every provider. |
| 53 | "Use the publicKeyMultibase to verify any Receipt signed by did:web:infernetprotocol.com" | /docs#api | CPR | PARTIAL | `did.json` is live with an Ed25519 key, but its advertised `CPRIssuer` endpoint `/api/cpr` returns 404. |

## Privacy, E2E and TEE

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 54 | "The control plane stores job metadata (timing, model, who paid) but not prompt content." / Privacy: "We do not store the prompts or completions of jobs you submit"; "What we don't collect: Prompts, completions…" | /faq, /privacy | privacy | BROKEN (false) | Prompts are stored in `jobs.input_spec` (`lib/data/chat.js:258-281`). Every streamed token is stored in `job_events.data` (`lib/data/node-api.js:418-427`; the NIM path does the same, `chat-stream.js`). Completions are stored in `jobs.result` (node-api.js:294). This is AES-GCM at rest **only if** `INFERNET_DB_ENCRYPTION_KEY` is set (`lib/encrypt.js:15-17`), and the server decrypts on read (`chat.js:345`). True E2E applies only on the /chat pre-selected provider path. |
| 55 | "You can delete your account at any time from the dashboard" | /privacy | privacy | MISSING | No delete-account UI or route in `apps/web`. |
| 56 | Subprocessors: "Railway, application hosting" | /privacy | privacy | BROKEN (stale) | Live is served by `nginx/1.28.3 (Ubuntu)` at 23.95.228.174. `/api/health` reports `commit:null` because it reads `RAILWAY_GIT_COMMIT_SHA` (`app/api/health/route.js:23`). |
| 57 | "Run with --no-advertise to never publish your IP" | /faq | privacy | SHIPPED | `apps/cli/commands/start.js:74,132`. |
| 58 | TEE / confidential compute |, | privacy | N/A | No TEE claim appears on any page. |

## Training

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 59 | "No search API key needed, the network proxies the crawl and enforces a per-node daily quota" | /getting-started | training | SHIPPED | `app/api/v1/search/route.js` (signed, VALUESERP key server-side, quota). `apps/cli/commands/train.js:937` `data`. |
| 60 | `infernet train init`, `infernet train run --local` (Unsloth) | /getting-started | training | SHIPPED | `apps/cli/commands/train.js:940-943`. Needs a Python stack. |
| 61 | "Train on the open network (federated LoRA), Pay any opted-in operator on the network … `--budget 5.00`" | /getting-started | training | PARTIAL | The market exists: `app/api/v1/training/*`, daemon `INFERNET_ACCEPT_TRAINING` (`start.js:1528`), and `fedAvg` (`train.js:641`). `--budget` is only stored (`lib/data/training-market.js:29`), and `shards/[id]/report/route.js:12` says payout is "TODO". Nobody is paid. The page does say "experimental". |
| 62 | "Scaffold is in via @infernetprotocol/training with backends for DeepSpeed, OpenRLHF, OpenDiLoCo, and Petals … Today the stub backend emits synthetic step events" | /faq | training | PARTIAL (disclosed) | `packages/training/src/backends/{deepspeed,opendiloco,openrlhf,petals}.js` are all "placeholder / integration pending". The default is `stub` (`index.js:56`). The npm description of `@infernetprotocol/training` lists them as if real. |
| 63 | "A peer-to-peer GPU compute marketplace, inference and distributed training" (tagline, title, footer) | / (all pages) | training | PARTIAL | The only distributed training is the experimental federated LoRA in #61. |
| 64 | `infernet publish ./run/checkpoint-final --hf … --ollama … --quant q4_k_m` (+ `--skip-hf/--skip-ollama/--modelfile-only`) | /getting-started | training | SHIPPED | `apps/cli/commands/publish.js` (all flags present). |
| 65 | Example model `rockypod/svelte-coder` | /getting-started | training | SHIPPED | https://ollama.com/rockypod/svelte-coder returns 200. |

## Distributed inference

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 66 | "Live today: Single-GPU & CPU inference" | / | distributed inference | PARTIAL | The code ships (Ollama/vLLM adapters, poll/stream). The live network has 0 online nodes, and `/gpu` and `/cpu` are empty. |
| 67 | Workload classes "A … B (tensor+pipeline intra-LAN) … B.5 (Petals) … C (OpenDiLoCo/Hivemind)" | /faq | distributed inference | PARTIAL | A: shipped. B: only via a local vLLM. B.5: removed (#24). C: placeholder (#62). |
| 68 | IPIP-0033 llama.cpp-RPC distributed mode (/chat checkbox, `/api/v1/rpc/census`) | /chat | distributed inference | PARTIAL | The route exists. Live census `ready:false`, and the RPC peer census in the daemon is hard-coded to return empty (`start.js:1105-1130`). |

## Install, CLI, SDK and packages

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 69 | "Run a node in two commands." `curl -fsSL https://c0mpute.com/install.sh \| sh && c0mpute plugin install infernet` | /, /docs, /getting-started | install | PARTIAL | `c0mpute.com/install.sh` returns 200. The binaries resolve: `c0mpute.com/releases/latest/c0mpute-linux-x86_64.tar.gz` → GitHub release v0.2.27 (200). The installer already installs infernet by default, via `c0mpute.com/plugins/infernet/install.sh`, which just `exec`s `infernetprotocol.com/install.sh`: a `git clone --depth 1` of master plus `pnpm install` (~2 GB, `install.sh:388,757`). `c0mpute plugin install` lives in another repo and was not verified. The minisign pubkey is the placeholder `RWQ_REPLACE_ME_WITH_PROD_MINISIGN_PUBKEY`. Not run end to end. |
| 70 | "Start here: curl -fsSL https://raw.githubusercontent.com/infernetprotocol/infernet-protocol/master/install.sh \| sh" | /protocol | install | SHIPPED | 200, byte-identical to `/install.sh` and repo `install.sh`. |
| 71 | "Start here: docker run --rm -it --gpus all ghcr.io/profullstack/infernet-provider:latest"; "Container image, GHCR provider image" | /protocol | install | BROKEN | Wrong owner: `release.yml:143` pushes `ghcr.io/infernetprotocol/infernet-provider`. GHCR refuses an anonymous pull token for `profullstack/…`, `infernetprotocol/…` and `infernetprotocol/infernet-protocol/…` (UNAUTHORIZED), which means private or nonexistent. The linked `github.com/infernetprotocol/infernet-protocol/pkgs/container/infernet-provider` returns 404. |
| 72 | Release v0.1.53: "For now, Docker is the supported install path" `ghcr.io/InfernetProtocol/infernet-provider:0.1.53` | GitHub release | install | BROKEN | Same as #71: the image cannot be pulled anonymously. The notes also require `SUPABASE_SERVICE_ROLE_KEY`. The release has **0 assets**. |
| 73 | `npm i -g @infernetprotocol/cli` (README roadmap; `install.sh` header "If npm is available AND the package is published") | npm / repo | packages | BROKEN | `@infernetprotocol/cli@0.1.53` (latest) depends on `@infernetprotocol/rpc-adapter@0.1.53`, which is **not on npm** (E404). `npm install --dry-run` fails with a 404. Every CLI version from 0.1.45 to 0.1.53 has this dependency, so the last installable version is 0.1.41. Repo `apps/cli/package.json` says 0.1.45 while npm says 0.1.53. (`install.sh` never actually tries npm; it always git-clones.) |
| 74 | npm `@infernetprotocol/cli` description: "register a GPU server with a Supabase control plane and start earning" | npm | packages | BROKEN (stale) | Conflicts with "never a database credential" and with the fact that nothing pays out. |
| 75 | npm `@infernetprotocol/engine` description: "pluggable backends (Mojo+MAX, in-process stub)" | npm | packages | PARTIAL (stale) | The real primary backends (ollama, vllm, llamacpp, sglang) are not mentioned. |
| 76 | npm published set: auth/config/deploy-providers/engine/gpu/sdk/cli @0.1.53; api-schema/db/logger/nim-adapter/payments/training @0.1.29; rpc-adapter, daemon, web, desktop, mobile not published | npm | packages | PARTIAL | The 0.1.29 packages are `private: true` in the repo but still on npm (stale). rpc-adapter is missing, which breaks the CLI (#73). |
| 77 | `brew install infernet` (README, release notes: "on the roadmap") | repo / GitHub | install | MISSING | The tap `profullstack/homebrew-infernet` holds `Formula/infernet.rb` = "# Placeholder, the real formula is published on the first release". The repo formula `tooling/dist/homebrew/infernet.rb` has url `cli-0.0.0.tgz` and sha256 all zeros. `infernetprotocol/homebrew-infernet` (named in README:446 and docs/RELEASING.md) does not exist. `TODO.md:30` claims a "Homebrew formula attached", but the release has no assets. The site itself does not advertise brew. |
| 78 | "SDK packages" / book "JS + Python" | /protocol, /book | SDK | PARTIAL | `@infernetprotocol/sdk` 0.1.53 is published with no dependencies and wraps the public `/api/*` and `/api/chat` routes (`packages/sdk-js/src/index.js:42-48`, `chat.js:27`). There is no Python SDK; "Python" means the OpenAI client pointed at `/v1`. |
| 79 | CLI surface: `setup` (`--confirm --model --no-firewall --skip-pull --backend`), `init` (`--no-advertise --p2p-port --role --url --name`), chat flags (`--remote --local --json --system --temperature --max-tokens`), `doctor --skip-e2e`, `tui`, `service install/enable/unit/...`, `model list/pull/use/show/remove`, `logs -f`, `upgrade`, `gpu --json`, `pubkey link`, `login` (device code) | /docs, /getting-started | CLI | SHIPPED | All flags and subcommands found in `apps/cli/commands/*.js` and `apps/cli/index.js:20-50,112`. `/api/auth/cli/{start,poll}` exist. |
| 80 | "Linux, macOS, or Windows (via WSL2)" | / | install | PARTIAL | `install.sh:11` "Linux or macOS, Windows not supported yet". WSL works only because it is Linux. |
| 81 | "Re-run the installer anytime to update." | / | install | SHIPPED | `install.sh:740-760` (`clone_or_update`). |
| 82 | "Mint a 24h deploy bearer at /deploy and paste the one-liner into your provider's user-data" | /faq | install | SHIPPED (code) | `app/api/v1/user/deploy/provision`, `app/api/deploy/{cloud-init,runpod}`. `/deploy` returns 307 → `/auth/login?next=/deploy`. The UI was not exercised. |
| 83 | Self-host: `cp sample.env .env`, `node tooling/generate-secrets.mjs`, `pnpm supabase:start/db:reset`, `docker build -f docker/Dockerfile` | /docs#self-host, /faq | install | SHIPPED | All of these files and scripts exist (root `package.json` scripts). |
| 84 | Self-host verify: `/api/health` → `"commit":"<sha>"` | /docs#self-host | install | PARTIAL | Live returns `commit:null` (the field is Railway-only). |

## Desktop and mobile apps

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 85 | (none: the site makes no desktop or mobile app claim) |, | desktop/mobile | N/A | `apps/desktop` (Electron) and `apps/mobile` exist in the repo but are not published (npm 404, no release assets). |

## Stats and dashboard

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 86 | "Latest CLI: v0.1.53 · Live · now" | /status | stats | BROKEN | v0.1.53 cannot be installed from npm (#73). Every live provider runs 0.1.45. |
| 87 | Dashboard: earnings, spend, GPUs in use, CPU pool, interconnect, linked identities, recent jobs; "No fake numbers." | /docs#dashboard | dashboard | SHIPPED | `app/dashboard/page.js:79-307`, `lib/data/dashboard.js`. Earnings can only ever be 0 (#39). |
| 88 | /gpu, /cpu fleet pages | /gpu, /cpu | stats | SHIPPED | They render honest empty states. |
| 89 | Status "Clients / Aggregators" panels | /status | stats | PARTIAL | Live they show "No clients found" and "No aggregators found". The client role is effectively unused. |
| 90 | Homepage numbers | / | stats | N/A | The homepage has no hardcoded network stats. All numbers come from `/api/overview` on /status. |

## Docs and links

| # | Claim (quoted) | Source URL | Area | Status | Evidence |
|---|---|---|---|---|---|
| 91 | Nav and footer links (Get started, Protocol, Docs, Book, FAQ, Chat, Deploy, Status, Careers, Contact, Terms, Privacy, GitHub, PDF, EPUB, Whitepaper) | all pages | docs | SHIPPED | All return 200 (/deploy returns 307 to login). Book chapters 01-06, `infernet-book.{html,pdf,epub}` and `whitepaper/infernet-whitepaper.pdf` all return 200. |
| 92 | `/auth/signup`, `/auth/login` (magic link if password blank), `/auth/reset-password`, `/auth/update-password`, `/auth/check-email` | /docs#auth | docs | SHIPPED | All 200. Routes are in `app/api/auth/*`. Not submitted. |
| 93 | `/protocol` "Payment flows are designed for multi-coin crypto settlement via CoinPayPortal" | /protocol | docs | PARTIAL | "Designed for" is accurate; nothing settles (#39). |
| 94 | llms.txt: "[Protocol] How the protocol works, matchmaking, escrow, CPR reputation, payment routing" | /llms.txt | docs | BROKEN (mismatch) | `/protocol` is a link hub with no protocol explanation, and escrow does not exist (#49). |
| 95 | Contact form "drop a note and we'll reply" | /contact | docs | SHIPPED (code) | `app/api/contact/route.js` (Resend). Not submitted. |

---

## Status counts (95 rows)

| Status | Count |
|---|---|
| SHIPPED (incl. "code" / "config" qualifiers) | 26 |
| PARTIAL | 30 |
| MISSING | 18 |
| BROKEN | 17 |
| N/A | 4 |

(Rows with a dual label, such as "MISSING / contradicted" or "PARTIAL (contradiction)", are counted under their first label.)

## Biggest gaps (top 10)

1. **Nobody gets paid, and clients cannot pay.** Every job has `payment_offer: 0` (`lib/data/chat.js:282`). Completion writes only a `pending-payout` placeholder when the amount is above zero (`node-api.js:302-316`). There is no payout sender, no escrow and no Lightning. This contradicts the headline "Earn crypto for the GPU you already have" and the payments copy on /, /faq, /docs and /careers.
2. **The privacy policy is false.** "We do not store the prompts or completions": the prompts, every token and the result are written to `jobs.input_spec`, `job_events.data` and `jobs.result`. They are encrypted at rest only if an env key is set, and the server can decrypt them.
3. **There are no API keys and no production API.** "Bring your own API key for production" and the book's `POST /api/v1/jobs` with dashboard API keys do not exist (404). `/v1/chat/completions` is anonymous and capped at 20 requests/hour per IP.
4. **The network is empty, and the /status numbers hide it.** 0 online of 41. "Models served 33" counts offline nodes, "Jobs 100" is a query limit, the providers table shows stale nodes as "available", and "no heartbeats yet" is misleading. Meanwhile /v1/models is empty.
5. **The advertised OpenAI quickstart likely fails.** `model: "qwen2.5:7b"` has no live provider, and the NIM fallback forwards the Ollama model id to NVIDIA unmapped (`chat-stream.js:143`). /chat's "No data center in the middle" is false whenever the fallback runs, which is always right now.
6. **`npm i -g @infernetprotocol/cli` is broken** for every version from 0.1.45 to 0.1.53: the missing `@infernetprotocol/rpc-adapter` returns 404. The status page advertises "Latest CLI v0.1.53".
7. **The Docker install path is broken.** The /protocol page uses the wrong GHCR owner (`profullstack`), and the image under `infernetprotocol` cannot be pulled anonymously. The container link returns 404. The release notes call Docker "the supported install path" and require a Supabase service-role key.
8. **The documented `infernet payout set` syntax is wrong in both places.** /getting-started uses `--coin/--address` plus `arbitrum` (rejected). /docs uses `BTC mainnet <addr>`, which saves the literal string "mainnet" as the payout address.
9. **The P2P "control plane can go dark" claim is unimplemented.** The c0mpute libp2p discovery and auctions are not wired (`start.js:1100-1130`), so all routing is through the central Supabase. The c0mpute plugin is just a wrapper around `install.sh`.
10. **Stale or false docs on distributed features.** Petals B.5 "we support" (it was removed), `INFERNET_RAY_MODE` (nothing reads it), the "Visible to N relay peers" warning (absent), `interconnectEnv` injected into engine env (never called), and the "Push model" dashboard UI (absent). All four real training backends are placeholders.

## Broken links and 404s

| URL | Where referenced | Result |
|---|---|---|
| https://github.com/infernetprotocol/infernet-protocol/pkgs/container/infernet-provider | /protocol "Container image" | 404 |
| `ghcr.io/profullstack/infernet-provider:latest` | /protocol "Start here" | not pullable (anonymous token refused; wrong owner) |
| `ghcr.io/InfernetProtocol/infernet-provider:0.1.53` | GitHub release v0.1.53 | not pullable anonymously |
| https://infernetprotocol.com/api/cpr | `/.well-known/did.json` CPRIssuer service | 404 |
| https://infernetprotocol.com/api/v1 | `/.well-known/did.json` control-plane service | 404 |
| https://infernetprotocol.com/api/v1/jobs, `/api/v1/jobs/:id` | /book (Building apps) | 404 |
| https://infernetprotocol.com/api/jobs/submit | /docs#api ("legacy alias for /api/jobs/submit") | 404 |
| https://infernetprotocol.com/api/v1/jobs/batch | /faq (disclosed as not live) | 404 |
| npm `@infernetprotocol/rpc-adapter@0.1.53` | dependency of `@infernetprotocol/cli@0.1.45`–`0.1.53` | E404 |
| Homebrew `profullstack/homebrew-infernet` Formula | README / release docs | placeholder file, no formula |
| `infernetprotocol/homebrew-infernet` repo | README:446, docs/RELEASING.md | does not exist |
| /nodes, /login, /signup, /pricing | not linked (guessed paths) | 404, harmless (real paths are /auth/login, /auth/signup) |

Every nav and footer link, book chapter, PDF/EPUB/whitepaper, Discord invite, GitHub IPIP/spec link and ollama.com example returned 200.
