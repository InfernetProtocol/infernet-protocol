# Infernet Protocol — TODO List

All application data flows through **Supabase** — operators pick self-hosted (via the Supabase CLI) or cloud (Infernet hosted); the code is identical either way. The Supabase client is server-only: it must be used inside Next.js route handlers and server components, never imported into client components. All JavaScript uses ESM and dependencies are managed with pnpm.

## Next up

- [ ] **Feature parity with the marketing (2026-10-06 audit):** see [docs/prd/TODO.md](docs/prd/TODO.md) (P0/P1/P2) and the PRDs in [docs/prd/](docs/prd/README.md).

- [ ] IPIP-0026 Phase 3 — TEE attestation. Heartbeat carries `tee` block; control plane verifies attestation against vendor cert chain; chat UI surfaces "TEE-attested" tier.
- [ ] IPIP-0028 Phase 3 — multi-node aggregator pattern (model key fan-out across providers). Phase 1 single-node is in.
- [ ] IPIP-0006 Phase 3+ — NIP-78 capability publish/subscribe + libp2p Kademlia DHT for peer discovery.
- [ ] IPIP-0022 — OpenVINO engine adapter + ARM64/RISC-V install branches.


---

## Recently shipped (removed from TODO)

The following items were on TODO.md but are live in master:

- `GET /api/nodes`, `GET /api/nodes/[id]`, `GET /api/jobs` — all Supabase-backed via `apps/web/lib/data/infernet.js`.
- `/dashboard` (and the new `/dashboard` server component) consumes `lib/data/dashboard` — no sample fallbacks.
- `/nodes` listing page — `apps/web/app/nodes/page.js` (+ `[id]`) is live.
- `/gpu` and `/cpu` fleet pages + `/api/gpu` and `/api/cpu` JSON endpoints — shipped 2026-05-03 (commit `12d49db`).
- Mobile `HomeScreen` / `JobsScreen` / `ProvidersScreen` now fetch real data from the Next.js API via `apps/mobile/src/lib/api.js` — shipped 2026-05-03 (commit `b0e128d`).
- `getStats()` in `packages/db/src/utils.js` runs real `count` queries against Supabase.
- Nostr / BIP-340 signature auth on `/api/v1/node/*` — shipped 2026-04-19.
- IPIP-0030 + IPIP-0031 proposal docs written; `ipips/README.md` index regenerated; 24 shipped IPIPs promoted out of `Draft` — shipped 2026-05-03 (commit `3314fd2`).
- Dead post-Phase-1 code deleted: `packages/inference/` (superseded by Petals / IPIP-0031), `apps/cli/lib/runtime-config.js` (legacy `supabase: {}` block + 12 other unused sections), `apps/cli/examples/app.js` (used the removed CLI Supabase client) — shipped 2026-05-03.
- Migration flow documented in `docs/MIGRATIONS.md` — covers `supabase db reset` (self-hosted), `supabase db push` (cloud), adding new migrations, and conventions — shipped 2026-05-03.
- Dependabot triage — 0 open alerts (78 fixed, 1 dismissed of 79 historical). Hardened `ip` to 2.0.1 via `pnpm.overrides`; documented the residual `pnpm audit` warning + RN-tooling reachability rationale in `docs/SECURITY.md` — shipped 2026-05-03.
- v0.1.41 cut and published 2026-05-03: every public `@infernetprotocol/*` package live on npm at `0.1.41`, `ghcr.io/infernetprotocol/infernet-provider:0.1.41` + `:latest` pushed (multi-arch), GitHub Release at `v0.1.41` with Homebrew formula attached. npm pipeline is unblocked.
- Optional sign-auth on legacy read routes (`/api/{overview,nodes,jobs,providers}`): when present, results scope to pubkey via `providers/aggregators/clients.public_key` + `jobs.client_pubkey`/`provider_id`. `/api/peers` stays public per IPIP-0006. — shipped 2026-05-03 (commit `4be8b3c`).
- Realtime-driven dashboard refresh: `RealtimeRefresh` + `/api/realtime/changes` SSE bridge subscribed to Supabase Realtime on `providers` + `jobs`. Replaces 10s polling on `/dashboard` and `/status`. — shipped 2026-05-03.
- Loading + error boundaries for `/dashboard`, `/status`, `/nodes/[id]`, root. — shipped 2026-05-03.
- IPIP-0026 §2 trust tiers: `providers.trust_tier` column + `minTrustTier` filter on `pickChatProvider`, plumbed through `/api/chat` and `/v1/chat/completions`. `private` providers excluded from open-market routing. — shipped 2026-05-03.
- IPIP-0027 §7-8: `e2e_capable`/`e2e_version` whitelisted in `sanitizeSpecs`, surfaced via `/api/chat/provider`, chat UI shows "🔒 End-to-end encrypted · Provider: <name>" banner when active and amber warning when the picked provider lacks NIP-44. — shipped 2026-05-03.
