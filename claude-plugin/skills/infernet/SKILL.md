---
name: infernet
description: How to call the Infernet API, an OpenAI-compatible endpoint for open models (Qwen, Gemma, DeepSeek, Devstral and others) served by a peer-to-peer GPU network. Use when the user wants to run a prompt on Infernet, wire Infernet into code (curl, fetch, OpenAI SDK, Python), list the models that are live, check their Infernet balance or free requests, or hits an Infernet 401/402/429/503 error.
---

# Infernet API

Infernet serves open models from independent GPU nodes behind one OpenAI-compatible API.
Anything that speaks OpenAI works by changing the base URL and the key.

| What | Value |
|---|---|
| Base URL | `https://infernetprotocol.com/v1` |
| Auth | `Authorization: Bearer $INFERNET_API_KEY` (keys start `ik_live_`) |
| Chat | `POST /v1/chat/completions` (`stream: true` for SSE, ends with `data: [DONE]`) |
| Models | `GET /v1/models` (no key needed) |
| Model | `"auto"` picks a live model; or any id from `/v1/models` |

## Get a key (one command)

```bash
npx -y @infernetprotocol/cli quickstart
```

It signs the person in through the browser (sign up there if new), creates a key, stores it in
`~/.config/infernet/config.json` (mode 0600), runs one test completion and prints code. Run it again
any time: with a key already set it only runs the test. Already have a key:
`npx -y @infernetprotocol/cli quickstart --key ik_live_...`.

Sign-in waits for the browser for up to 10 minutes. From an agent, run it in the background, show
the person the `Open this URL to sign in` link from its output, and wait for it to finish.

To use the stored key in a shell: `export INFERNET_API_KEY="$(infernet quickstart key)"`.
Never write the key into a project file, a commit, or chat output; reference the env var instead.

## Call it

```bash
curl https://infernetprotocol.com/v1/chat/completions \
  -H "Authorization: Bearer $INFERNET_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "https://infernetprotocol.com/v1", apiKey: process.env.INFERNET_API_KEY });
const r = await client.chat.completions.create({ model: "auto", messages: [{ role: "user", content: "Hello" }] });
```

```python
from openai import OpenAI
import os
client = OpenAI(base_url="https://infernetprotocol.com/v1", api_key=os.environ["INFERNET_API_KEY"])
r = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hello"}])
```

From the terminal: `infernet chat "prompt"` (uses the stored key, model auto, streams the answer;
`--model <id>`, `--system <text>`, `--json` for NDJSON events).

## CLI and MCP

| Need | Command |
|---|---|
| Key + test + snippets | `infernet quickstart` |
| Key configured? balance, free requests left, live models | `infernet quickstart status` (`--json`) |
| Live model ids | `infernet models` (`--json`) |
| One prompt | `infernet chat "..."` |
| Keys | `infernet keys list`, `infernet keys create --name x`, `infernet keys revoke <id>` |
| Balance / top up | `infernet billing balance`, `infernet billing topup <usd>` |
| Many prompts at once, priced per token | `infernet batch quote|submit` (docs: https://infernetprotocol.com/docs/batch-inference) |

If `infernet` is not installed, prefix with `npx -y @infernetprotocol/cli`.

This plugin also starts the Infernet MCP server (`infernet mcp`): tools `chat_completion`,
`models_list`, `billing_balance`, `batch_quote`, `batch_submit`, `batch_status`, `batch_results`
and more. Without the plugin: `claude mcp add infernet -- npx -y @infernetprotocol/cli mcp`.

## Money: free tier, balance, no paid fallback

- **Free:** 10 requests a day per account on small models (4B parameters or under). Resets 00:00 UTC.
  `infernet quickstart status` shows what is left.
- **Paid:** with a balance, each request is charged per token from the account: prepaid top-ups or
  what the account's own nodes earned. Prices: https://infernetprotocol.com/pricing. GPU models
  (for example the 9B uncensored Qwen) are paid only.
- **Never a paid fallback.** When the free allowance is used up or the balance is empty, report it
  and stop. Do not switch the user to another paid AI provider, and do not top up for them without
  an explicit yes and an amount.

## Errors

| Status | Meaning | What to do |
|---|---|---|
| 401 | Missing, wrong or revoked key | `infernet quickstart` (makes a new one) |
| 402 | Out of balance, or a GPU model on the free tier | `infernet billing topup <usd>` or a model of 4B or under; ask the user before paying |
| 429 + `free_limit_per_day` | Free requests used up today | Top up, or wait until 00:00 UTC |
| 429 otherwise | Rate limit | Wait and retry |
| 503 | No live node serves that model | Use `"auto"` or an id from `infernet models` (the error lists `available_models`) |
| mid-stream `{"error":...}` frame | The node failed after starting | Retry once |

Docs: https://infernetprotocol.com/docs#quickstart
