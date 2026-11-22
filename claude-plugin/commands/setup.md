---
description: Get an Infernet API key in one step (sign in, create + store a key, test call, code snippets)
argument-hint: "[ik_live_... existing key]"
allowed-tools: Bash(infernet:*), Bash(npx -y @infernetprotocol/cli:*), Bash(command -v infernet)
---

# /infernet:setup

Set up the Infernet API for this user with the CLI's quickstart. Load the `infernet:infernet` skill
if you need the API details.

1. Pick the runner: if `command -v infernet` succeeds use `infernet`, otherwise
   `npx -y @infernetprotocol/cli@latest`. Call it `$CLI` below.
2. If the user gave a key in the arguments (`$ARGUMENTS` starts with `ik_live_`), run
   `$CLI quickstart --key <that key>` and go to step 4.
3. Otherwise run `$CLI quickstart` **in the background** (sign-in waits up to 10 minutes for the
   browser). Read its output until it prints either `Open this URL to sign in:` or a test answer.
   - If it printed a sign-in URL, give the user that link and say: open it, sign in or sign up,
     then come back. Wait for the background command to finish.
   - If a key was already configured, it skips straight to the test call. That is fine.
4. Report, briefly:
   - the test answer and the model that gave it, or the error and what to do about it (see the
     skill's error table: 402 = balance, 429 = free requests used up; never suggest a paid
     third-party fallback);
   - where the key is stored (`~/.config/infernet/config.json`) and how to export it:
     `export INFERNET_API_KEY="$(infernet quickstart key)"`;
   - one snippet in the language of the user's project (curl, fetch, OpenAI SDK or Python), with
     base URL `https://infernetprotocol.com/v1`, model `"auto"` and `process.env.INFERNET_API_KEY`
     / `os.environ["INFERNET_API_KEY"]`.

Never print the full key in your reply and never write it into a project file.

User arguments: $ARGUMENTS
