/**
 * `infernet chat` — run an inference, either through the P2P network
 * (default when a control plane is configured) or against the local
 * engine (Ollama/Mojo/stub).
 *
 *   infernet chat "what is 2+2"            # auto: P2P if configured, else local
 *   infernet chat --remote "..."           # force network — control plane required
 *   infernet chat --local  "..."           # force local — no control plane call
 *
 * P2P path:
 *   POST <url>/api/chat                  → control plane creates job, picks
 *                                          a provider (or NIM fallback)
 *   GET  <url>/api/chat/stream/<jobId>   → SSE: job | meta | token | done | error
 *
 * Local path:
 *   createEngine()  →  Ollama / Mojo / stub  →  tokens straight to stdout.
 *
 * Exits 0 on `done`, non-zero on `error`.
 */

import { createEngine, MSG } from "@infernetprotocol/engine";
import { loadConfig } from "../lib/config.js";
import { submitChatJob, streamChatEvents } from "../lib/remote-chat.js";
import { createPluginsClient, readSse } from "../lib/plugins-client.js";
import { createInterface } from "node:readline/promises";

const HELP = `infernet chat — run a chat inference (P2P network or local)

Usage:
  infernet chat [flags] [prompt]
  echo "..." | infernet chat [flags]

Routing:
  --remote               Force the P2P network (control plane required).
  --local                Force the local engine (Ollama / Mojo / stub).
  (default)              Use the network if config.controlPlane.url is
                         set; otherwise fall back to the local engine.

Common flags:
  --model <name>         Model id (e.g. qwen2.5:7b). $INFERNET_ENGINE_MODEL fallback.
  --system <text>        Prepend a system message.
  --temperature <num>    Sampling temperature.
  --max-tokens <num>     Cap on generated tokens.
  --json                 Emit raw events as NDJSON instead of token stream.
  -h, --help             Show this help.

Network-only flags:
  --url <url>            Control-plane URL override (default: config.controlPlane.url).
  --no-plugins           Do not use your plugins for this message (see \`infernet plugins\`).
  --yes                  Allow plugin tools that change things without asking.

Plugins: when you are signed in (\`infernet login\`) and have plugins on, the
network turn runs with them: the model can call their tools, and tools that
change or delete things ask first. Plugin turns are sent in plaintext.

Local-only flags:
  --backend <kind>       ollama | mojo | stub. Default: auto.
  --host <url>           Override Ollama host. Default: \$OLLAMA_HOST or localhost:11434.
`;

async function readStdin() {
    if (process.stdin.isTTY) return "";
    let buf = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) buf += chunk;
    return buf;
}

function emitJson(obj) {
    process.stdout.write(JSON.stringify(obj) + "\n");
}

async function runRemote({ baseUrl, messages, model, temperature, maxTokens, jsonMode }) {
    const ctrl = new AbortController();
    const onSigint = () => {
        process.stderr.write("\n[cancelled]\n");
        ctrl.abort();
    };
    process.on("SIGINT", onSigint);

    let exitCode = 0;
    try {
        let job;
        try {
            job = await submitChatJob(baseUrl, {
                messages,
                model,
                maxTokens,
                temperature,
                signal: ctrl.signal
            });
        } catch (err) {
            process.stderr.write(`error: failed to submit job to ${baseUrl}: ${err?.message ?? err}\n`);
            return 1;
        }

        if (!process.stdout.isTTY || jsonMode) {
            // No-op: in JSON / piped mode, header is omitted.
        } else {
            const provHint = job.provider
                ? `provider=${job.provider.name ?? job.provider.nodeId ?? job.provider.id}`
                : "no provider";
            process.stderr.write(
                `[infernet] job=${job.jobId}  via=${job.source}  ${provHint}\n`
            );
        }

        if (jsonMode) emitJson({ type: "job", ...job });

        for await (const ev of streamChatEvents(baseUrl, job.streamUrl, { signal: ctrl.signal })) {
            if (jsonMode) {
                emitJson(ev);
                continue;
            }
            switch (ev.event) {
                case "token":
                    process.stdout.write(ev.data?.text ?? "");
                    break;
                case "done":
                    if (process.stdout.isTTY) process.stdout.write("\n");
                    break;
                case "error":
                    process.stderr.write(`\nerror: ${ev.data?.message ?? "remote error"}\n`);
                    exitCode = 1;
                    break;
                default:
                    // job / meta / unknown — silent in plain mode
                    break;
            }
        }
    } finally {
        process.off("SIGINT", onSigint);
    }
    return exitCode;
}

async function askApproval(call) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) return "deny";
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const args = JSON.stringify(call.arguments ?? {});
        const a = await rl.question(`\n[plugin] allow ${call.pluginName || call.plugin} to run ${call.title || call.tool} ${args}? [y/N] `);
        return /^y(es)?$/i.test(a.trim()) ? "allow" : "deny";
    } finally {
        rl.close();
    }
}

/** A network turn with your plugins: the server runs the tool loop, we render its events. */
async function runPluginChat({ baseUrl, token, messages, model, maxTokens, jsonMode, autoYes }) {
    let body = { messages, plugins: true, ...(model ? { modelName: model } : {}), ...(typeof maxTokens === "number" ? { maxTokens } : {}) };
    const tty = process.stdout.isTTY && !jsonMode;
    for (let round = 0; round < 6; round++) {
        const res = await fetch(new URL("/api/chat", baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` },
            body: JSON.stringify(body)
        });
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
            const t = await res.text().catch(() => "");
            let msg = t.slice(0, 300);
            try { msg = JSON.parse(t).error ?? msg; } catch { /* text */ }
            process.stderr.write(`error: ${msg || `HTTP ${res.status}`}\n`);
            return 1;
        }
        let draft = "";
        let printed = 0;
        let pending = null;
        let failed = false;
        for await (const ev of readSse(res)) {
            if (jsonMode) { emitJson(ev); }
            if (ev.type === "step") { draft = ""; printed = 0; }
            else if (ev.type === "token" && !jsonMode) {
                draft += ev.text;
                // Hold back a tool_call block; print prose as it streams.
                const cut = draft.search(/```[ \t]*tool|<tool_call/i);
                const shown = cut === -1 ? draft.replace(/`{1,3}$/, "") : draft.slice(0, cut);
                if (shown.length > printed) { process.stdout.write(shown.slice(printed)); printed = shown.length; }
            } else if (ev.type === "tool_call" && !jsonMode) {
                if (printed) process.stdout.write("\n");
                process.stderr.write(`[plugin] ${ev.plugin} · ${ev.title || ev.tool} ${JSON.stringify(ev.arguments ?? {})}\n`);
            } else if (ev.type === "tool_result" && !jsonMode) {
                const first = String(ev.text ?? "").split("\n").slice(0, 3).join(" ").slice(0, 200);
                process.stderr.write(`[plugin] ${ev.denied ? "declined" : ev.isError ? "error" : "ok"}: ${first}\n`);
            } else if (ev.type === "plugins_skipped" && !jsonMode) {
                process.stderr.write(`[plugin] not used (sign in: infernet plugins connect <slug>): ${ev.skipped.map((s) => s.slug).join(", ")}\n`);
            } else if (ev.type === "text" && !jsonMode) {
                if (ev.text.length > printed) process.stdout.write(ev.text.slice(printed));
                if (tty) process.stdout.write("\n");
            } else if (ev.type === "approval_needed") {
                pending = ev;
            } else if (ev.type === "error") {
                if (!jsonMode) process.stderr.write(`\nerror: ${ev.message}\n`);
                failed = true;
            }
        }
        if (failed) return 1;
        if (!pending) return 0;
        const decision = autoYes ? "allow" : await askApproval(pending.call);
        body = { plugins: true, resume: { approvalId: pending.approvalId, decision }, ...(model ? { modelName: model } : {}) };
    }
    return 0;
}

async function runLocal({ engineOpts, messages, model, temperature, maxTokens, jsonMode }) {
    let engine;
    try {
        engine = await createEngine(engineOpts);
    } catch (err) {
        process.stderr.write(`engine init failed: ${err?.message ?? err}\n`);
        return 1;
    }

    const generation = engine.generate({
        messages,
        model,
        temperature,
        max_tokens: maxTokens
    });

    const onSigint = () => {
        process.stderr.write("\n[cancelled]\n");
        generation.cancel();
    };
    process.on("SIGINT", onSigint);

    let exitCode = 0;
    try {
        for await (const ev of generation.stream) {
            if (jsonMode) {
                emitJson(ev);
                continue;
            }
            switch (ev.type) {
                case MSG.TOKEN:
                    process.stdout.write(ev.text ?? "");
                    break;
                case MSG.DONE:
                    if (process.stdout.isTTY) process.stdout.write("\n");
                    break;
                case MSG.ERROR:
                    process.stderr.write(`\nerror: ${ev.message ?? "engine error"}\n`);
                    exitCode = 1;
                    break;
                default:
                    break;
            }
        }
    } finally {
        process.off("SIGINT", onSigint);
        try { await engine.shutdown(); } catch { /* best-effort */ }
    }
    return exitCode;
}

export default async function chat(args) {
    if (args.has("help") || args.has("h")) {
        process.stdout.write(HELP);
        return 0;
    }

    // Reclaim values eaten by the greedy parser for known-boolean flags.
    const reclaimed = [];
    for (const name of ["json", "remote", "local", "no-plugins", "yes"]) {
        const v = args.get(name);
        if (typeof v === "string") reclaimed.push(v);
    }
    const positional = [...reclaimed, ...(args.positional ?? [])];
    let prompt = positional.join(" ").trim();
    if (!prompt) prompt = (await readStdin()).trim();
    if (!prompt) {
        process.stderr.write("error: no prompt — pass as argument or pipe via stdin\n\n");
        process.stderr.write(HELP);
        return 2;
    }

    const messages = [];
    const sys = args.get("system");
    if (sys) messages.push({ role: "system", content: String(sys) });
    messages.push({ role: "user", content: prompt });

    const config = (await loadConfig()) ?? {};
    const cfgEngine = config.engine ?? {};
    const cfgUrl = config.controlPlane?.url ?? null;

    // Mode resolution.
    const wantRemote = args.has("remote");
    const wantLocal = args.has("local");
    if (wantRemote && wantLocal) {
        process.stderr.write("error: --remote and --local are mutually exclusive\n");
        return 2;
    }
    const urlArg = args.get("url");
    const remoteUrl = (urlArg ? String(urlArg) : null) ?? cfgUrl;
    let mode;
    if (wantLocal) mode = "local";
    else if (wantRemote) mode = "remote";
    else mode = remoteUrl ? "remote" : "local";

    const model =
        args.get("model") ?? process.env.INFERNET_ENGINE_MODEL ?? cfgEngine.model ?? null;
    const temperature =
        args.get("temperature") != null ? Number(args.get("temperature")) : undefined;
    const maxTokens =
        args.get("max-tokens") != null ? Number(args.get("max-tokens")) : undefined;
    const jsonMode = args.has("json");

    if (mode === "remote") {
        if (!remoteUrl) {
            process.stderr.write(
                "error: --remote requested but no control-plane URL configured.\n" +
                "       set one with `infernet init` or pass --url <https://...>\n"
            );
            return 2;
        }
        // Signed in with plugins on: the turn runs with them.
        const token = config.auth?.bearerToken ?? null;
        if (token && !args.has("no-plugins")) {
            try {
                const d = await createPluginsClient({ baseUrl: remoteUrl.replace(/\/+$/, ""), token }).list();
                const usable = (d.plugins ?? []).filter((p) => p.enabled && !p.needs_sign_in);
                if (usable.length) {
                    return runPluginChat({ baseUrl: remoteUrl, token, messages, model, maxTokens, jsonMode, autoYes: args.has("yes") });
                }
            } catch {
                /* plugins unavailable: plain network turn */
            }
        }
        return runRemote({
            baseUrl: remoteUrl,
            messages,
            model,
            temperature,
            maxTokens,
            jsonMode
        });
    }

    // Local path
    const backendOpt =
        args.get("backend") ?? process.env.INFERNET_ENGINE_BACKEND ?? cfgEngine.backend ?? null;
    const host =
        args.get("host") ?? process.env.OLLAMA_HOST ?? cfgEngine.ollamaHost ?? null;
    const engineOpts = {};
    if (backendOpt && backendOpt !== "auto") engineOpts.backend = String(backendOpt);
    if (host) engineOpts.host = String(host);
    if (model) engineOpts.defaultModel = model;

    return runLocal({
        engineOpts,
        messages,
        model,
        temperature,
        maxTokens,
        jsonMode
    });
}
