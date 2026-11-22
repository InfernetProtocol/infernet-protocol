---
description: Ask an open model on the Infernet network (model auto unless you name one)
argument-hint: "<prompt> [--model <id>]"
allowed-tools: Bash(infernet:*), Bash(npx -y @infernetprotocol/cli:*), Bash(command -v infernet), mcp__plugin_infernet_infernet__chat_completion
---

# /infernet:chat

Send the user's prompt to Infernet and show the answer.

Prompt and flags: $ARGUMENTS

- Prefer the `chat_completion` tool of the infernet MCP server when it is available (`prompt`,
  optional `model`, `system`, `max_tokens`).
- Otherwise run `infernet chat --no-plugins --json <flags> "<prompt>"` (or `npx -y @infernetprotocol/cli@latest
  chat --json ...` when `infernet` is not on PATH). Quote the prompt safely for the shell. The last
  NDJSON line is `{"type":"done","model":...,"text":...}` or `{"type":"error",...}`.

Show the answer text, then one short line naming the model. If there is no API key, tell the user
to run `/infernet:setup`. On 402 or a free-limit 429, explain it (balance empty / 10 free requests
a day used) and stop: do not retry on another provider.
