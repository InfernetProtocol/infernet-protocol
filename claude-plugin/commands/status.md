---
description: Infernet API status - key configured, balance, free requests left today, live models
allowed-tools: Bash(infernet:*), Bash(npx -y @infernetprotocol/cli:*), Bash(command -v infernet)
---

# /infernet:status

Run `infernet quickstart status --json` (or `npx -y @infernetprotocol/cli@latest quickstart status
--json` when `infernet` is not on PATH). Exit code 1 only means no key is configured.

Report in a few lines:
- API key: configured or not (masked value and where it comes from; never the full key). If not,
  point to `/infernet:setup`.
- Balance: `balance.total_spendable_usd`, if present.
- Free requests left today: `free_today.remaining` of `free_today.limit` (resets 00:00 UTC).
- Live models: how many, and a few ids.
Mention any `*_error` field plainly.
