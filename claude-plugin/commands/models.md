---
description: List the models live on the Infernet network right now
allowed-tools: Bash(infernet:*), Bash(npx -y @infernetprotocol/cli:*), Bash(command -v infernet), Bash(curl -s https://infernetprotocol.com/v1/models), mcp__plugin_infernet_infernet__models_list
---

# /infernet:models

List the model ids live on Infernet now. Use the infernet MCP `models_list` tool if available,
otherwise `infernet models --json` (or `npx -y @infernetprotocol/cli@latest models --json`), or as
a last resort `curl -s https://infernetprotocol.com/v1/models` (no key needed).

Show them as a compact list. Remind the user that `"auto"` lets the network pick, that the free tier
covers models of 4B parameters or under, and that prices are on https://infernetprotocol.com/pricing.
