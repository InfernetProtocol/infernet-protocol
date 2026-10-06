# PRD 09: Install paths and packages

Priority: **P0** (npm and Docker paths are broken) / P1 (brew, Windows)

## Problem
Three of the advertised install paths do not work, and the copy that tells operators how to set payouts is wrong.

## Claims being made
- "Run a node in two commands": `curl -fsSL https://c0mpute.com/install.sh | sh && c0mpute plugin install infernet` (/, /docs, /getting-started).
- `curl .../install.sh | sh` (/protocol, README).
- `docker run --rm -it --gpus all ghcr.io/profullstack/infernet-provider:latest` (/protocol); release notes: "For now, Docker is the supported install path".
- `npm i -g @infernetprotocol/cli` (README, `install.sh` header).
- `brew install infernet` (README, release notes "on the roadmap").
- "Linux, macOS, or Windows (via WSL2)" (/).
- /status "Latest CLI v0.1.53".

## Current state (evidence)
- **npm: broken.** `@infernetprotocol/cli@0.1.53` depends on `@infernetprotocol/rpc-adapter@0.1.53`, which is not on npm (E404), since 0.1.45. `release.yml` never published it. **Fixed by PR #27** (adds it plus a guard test); needs a 0.1.54 release.
- **Docker: broken.** /protocol names `ghcr.io/profullstack/...`; `release.yml:143` pushes `ghcr.io/infernetprotocol/infernet-provider`, and that package is not anonymously pullable (private) and its GitHub link 404s. Release notes tell operators to pass `SUPABASE_SERVICE_ROLE_KEY`, which contradicts "never a database credential".
- **brew: placeholder.** The tap's `Formula/infernet.rb` is "# Placeholder"; GitHub release v0.1.53 has 0 assets.
- **curl installer: works**, but git-clones master and runs `pnpm install` (~2 GB), and the daemon self-updates from master mid-job (PRD 02).
- `install.sh:11`: "Linux or macOS; Windows not supported yet".
- npm descriptions are stale (`cli`: "register a GPU server with a Supabase control plane"; `engine`: "Mojo+MAX, in-process stub"). 6 packages marked `private` in the repo are still on npm at 0.1.29.

## Requirements
1. Release 0.1.54 with rpc-adapter; CI smoke test: `npm i -g @infernetprotocol/cli@<new>` in a clean container, then `infernet help`.
2. Make the GHCR image public, fix the owner on /protocol, remove the service-role key from release notes.
3. Either publish a real brew formula from the release job or remove brew from the README.
4. Installer: ship a prebuilt bundle (no pnpm install on the node), and pin updates to tagged releases instead of master.
5. Refresh npm descriptions; deprecate the stale private packages on npm.
6. Say "Windows via WSL2" consistently.

## Acceptance criteria
- Each install path on the site has a CI job that runs it in a clean container weekly and reports.
- `npm view @infernetprotocol/rpc-adapter version` equals the CLI version.
