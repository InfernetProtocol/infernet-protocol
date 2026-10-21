/**
 * `infernet doctor` — diagnose all three sides of a P2P chat round-trip.
 *
 *   1. Local config       — file present, mode 0600, has identity + URL
 *   2. Engine             — Ollama reachable, configured model is pulled
 *   3. Control plane      — URL responds, /api/overview is reachable
 *   4. Daemon             — running, IPC socket healthy, recent heartbeat
 *   5. Provider row       — signed `me` returns this node's row
 *   6. End-to-end         — submit a tiny chat job, see it routed + done
 *
 * Each check is independent — failures don't abort, they're reported
 * with a remediation hint and the doctor moves on. Exit 0 if all pass,
 * 1 if any failed.
 *
 * Usage:
 *   infernet doctor               # full sweep
 *   infernet doctor --skip-e2e    # skip the test inference
 *   infernet doctor --url <url>   # override control-plane URL
 */

import fs from "node:fs/promises";
import { loadConfig, getConfigPath, getConfigDir, getDaemonLogPath, fixConfigPermissions } from "../lib/config.js";
import { isDaemonAlive, sendToDaemon } from "../lib/ipc.js";
import { readLiveSupervisorPid, spawnDetachedSupervisor } from "../lib/supervisor.js";
import { createNodeClient } from "../lib/node-client.js";
import { submitChatJob, streamChatEvents } from "../lib/remote-chat.js";

const HELP = `infernet doctor — diagnose P2P chat readiness

Usage:
  infernet doctor [flags]

Flags:
  --url <url>      Override control-plane URL (default: config.controlPlane.url)
  --skip-e2e       Skip the end-to-end test inference
  --model <name>   Model to request in the e2e test (default: config.engine.model)
  --json           Emit results as one JSON object per check
  -h, --help       Show this help

Exit code: 0 if every check passes, 1 if any fails.
`;

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
    reset: TTY ? "\x1b[0m" : "",
    bold: TTY ? "\x1b[1m" : "",
    dim: TTY ? "\x1b[2m" : "",
    green: TTY ? "\x1b[32m" : "",
    red: TTY ? "\x1b[31m" : "",
    yellow: TTY ? "\x1b[33m" : "",
    blue: TTY ? "\x1b[34m" : ""
};

const ICON = {
    ok: `${C.green}✓${C.reset}`,
    fail: `${C.red}✗${C.reset}`,
    warn: `${C.yellow}!${C.reset}`,
    skip: `${C.dim}—${C.reset}`
};

function printCheck(idx, total, name, result) {
    const icon = ICON[result.status] ?? "?";
    const pad = name.padEnd(26);
    process.stdout.write(`[${idx}/${total}] ${pad} ${icon}  ${result.summary}\n`);
    if (result.details) {
        for (const line of result.details.split("\n")) {
            if (line) process.stdout.write(`                                ${C.dim}${line}${C.reset}\n`);
        }
    }
    if (result.hint) {
        process.stdout.write(`                                ${C.yellow}→${C.reset} ${result.hint}\n`);
    }
}

// ---------------------------------------------------------------------------
// 1. Local config
// ---------------------------------------------------------------------------
async function checkConfig() {
    const path = getConfigPath();
    let stat;
    try {
        stat = await fs.stat(path);
    } catch {
        return {
            status: "fail",
            summary: `no config at ${path}`,
            hint: "run `infernet init` to create one"
        };
    }
    const config = await loadConfig();
    if (!config) {
        return {
            status: "fail",
            summary: `config at ${path} is unreadable`,
            hint: "delete it and re-run `infernet init`"
        };
    }
    const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
    const role = config.node?.role ?? "(unset)";
    const name = config.node?.name ?? config.node?.nodeId ?? "(unnamed)";
    const hasKey = !!(config.node?.publicKey && config.node?.privateKey);
    const hasUrl = !!config.controlPlane?.url;

    const issues = [];
    if (mode !== "600") {
        // Auto-heal: fix permissions right here so the next daemon start
        // doesn't find them wrong.
        try {
            await fixConfigPermissions();
        } catch { /* ignore — may already be correct */ }
        issues.push(`mode was ${mode} (auto-fixed to 600)`);
    }
    if (!hasKey) issues.push("missing Nostr keypair");
    if (!hasUrl) issues.push("missing controlPlane.url");

    if (issues.length) {
        const onlyPermFix = issues.length === 1 && issues[0].includes("auto-fixed");
        return {
            status: onlyPermFix ? "ok" : "fail",
            summary: `${role}/${name}, key=${config.node.publicKey?.slice(0, 12) ?? "?"}…`,
            details: issues.join("\n"),
            hint: !hasKey || !hasUrl ? "run `infernet init` to fix" : undefined,
            config
        };
    }
    return {
        status: "ok",
        summary: `${role}/${name}, key=${config.node.publicKey.slice(0, 12)}…`,
        details: `path: ${path} (mode ${mode})\nurl:  ${config.controlPlane.url}`,
        config
    };
}

// ---------------------------------------------------------------------------
// 2. Engine (Ollama + configured model)
// ---------------------------------------------------------------------------
async function checkEngine(config) {
    const cfgEngine = config?.engine ?? {};
    const host = cfgEngine.ollamaHost ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
    const wantedModel = cfgEngine.model ?? null;

    let body;
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(new URL("/api/tags", host), { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = await res.json();
    } catch (err) {
        return {
            status: "fail",
            summary: `Ollama not reachable at ${host}`,
            details: err?.message ?? String(err),
            hint: "run `infernet setup` to install / start Ollama"
        };
    }

    const models = body.models ?? [];
    if (!wantedModel) {
        return {
            status: "warn",
            summary: `Ollama up @ ${host}, ${models.length} model${models.length === 1 ? "" : "s"} pulled, no engine.model set`,
            hint: "run `infernet model use <name>` to pick one"
        };
    }
    const have = models.some((m) => (m.name ?? m.model) === wantedModel);
    if (!have) {
        return {
            status: "fail",
            summary: `engine.model=${wantedModel} not pulled`,
            hint: `run \`infernet model pull ${wantedModel}\``
        };
    }
    return {
        status: "ok",
        summary: `Ollama up @ ${host}, model ${wantedModel} pulled`
    };
}

// ---------------------------------------------------------------------------
// 3. Control plane reachability
// ---------------------------------------------------------------------------
async function checkControlPlane(url) {
    if (!url) {
        return {
            status: "fail",
            summary: "no control-plane URL",
            hint: "set with `infernet login --url <https://...>`"
        };
    }
    const start = Date.now();
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(new URL("/api/overview", url), { signal: ctrl.signal });
        clearTimeout(t);
        const elapsed = Date.now() - start;
        if (!res.ok) {
            return {
                status: "fail",
                summary: `${url} → HTTP ${res.status}`,
                details: `${elapsed}ms`,
                hint: "verify the URL or check the deployment is up"
            };
        }
        return {
            status: "ok",
            summary: `${url} (HTTP ${res.status}, ${elapsed}ms)`
        };
    } catch (err) {
        return {
            status: "fail",
            summary: `${url} unreachable`,
            details: err?.message ?? String(err),
            hint: "verify network access to the control plane"
        };
    }
}

// ---------------------------------------------------------------------------
// 4. Daemon
// ---------------------------------------------------------------------------
async function checkDaemon() {
    let alive = await isDaemonAlive(500);
    if (!alive) {
        // Auto-start: doctor starts the daemon rather than just warning.
        try {
            // A live supervisor is already bringing the daemon back.
            if (!readLiveSupervisorPid()) spawnDetachedSupervisor([]);
        } catch (err) {
            return {
                status: "fail",
                summary: "daemon not running, auto-start failed",
                details: err?.message ?? String(err),
                hint: "check config with `infernet init` then run `infernet start`"
            };
        }
        // Poll up to 15 seconds — Node.js + ESM startup can be slow.
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 500));
            alive = await isDaemonAlive(500);
            if (alive) break;
        }
        if (!alive) {
            // Grab last few log lines to surface the crash reason.
            let logTail = "";
            try {
                const logPath = getDaemonLogPath();
                const raw = await fs.readFile(logPath, "utf8");
                const lines = raw.trimEnd().split("\n");
                logTail = lines.slice(-6).join("\n");
            } catch { /* log may not exist yet */ }
            return {
                status: "fail",
                summary: "daemon auto-start attempted but not responding",
                details: logTail || undefined,
                hint: "check full log with `infernet logs`"
            };
        }
        // Wait for the first heartbeat so downstream checks (provider row,
        // e2e) see status=available rather than the registration-time default.
        process.stdout.write("                                auto-started daemon, waiting for first heartbeat…\n");
        for (let i = 0; i < 90; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const probe = await sendToDaemon("stats", null, { timeoutMs: 1000 });
            if (probe?.ok && probe.data?.stats?.lastHeartbeatAt) break;
        }
    }
    const r = await sendToDaemon("stats", null, { timeoutMs: 1500 });
    if (!r?.ok) {
        return {
            status: "fail",
            summary: "daemon reachable but stats call failed",
            details: r?.error ?? "unknown",
            hint: "try `infernet stop && infernet start`"
        };
    }
    const stats = r.data?.stats ?? {};
    const lastHb = stats.lastHeartbeatAt;
    const ageMs = lastHb ? Date.now() - new Date(lastHb).getTime() : null;
    if (ageMs == null) {
        return {
            status: "warn",
            summary: `pid=${r.data?.pid}, never heartbeated yet`,
            hint: "wait ~30s, then re-run doctor"
        };
    }
    if (ageMs > 60_000) {
        return {
            status: "fail",
            summary: `last heartbeat ${Math.round(ageMs / 1000)}s ago`,
            details: stats.lastHeartbeatError ?? "",
            hint: "check the daemon log: `infernet logs`"
        };
    }
    return {
        status: "ok",
        summary: `pid=${r.data?.pid}, last heartbeat ${Math.round(ageMs / 1000)}s ago, jobs ${stats.jobsCompleted ?? 0}/${stats.jobsPicked ?? 0}`
    };
}

// ---------------------------------------------------------------------------
// 5. Provider row on the control plane
// ---------------------------------------------------------------------------
async function checkProviderRow(config) {
    if (!config.controlPlane?.url || !config.node?.publicKey) {
        return { status: "skip", summary: "no URL or pubkey — skipped" };
    }
    let client;
    try {
        client = createNodeClient({
            url: config.controlPlane.url,
            publicKey: config.node.publicKey,
            privateKey: config.node.privateKey,
            role: config.node.role
        });
    } catch (err) {
        return {
            status: "fail",
            summary: "could not build signed client",
            details: err?.message ?? String(err)
        };
    }
    try {
        const row = await client.me();
        const model = row?.gpu_model ?? row?.model ?? null;
        const status = row?.status ?? "unknown";
        return {
            status: "ok",
            summary: `registered as ${config.node.publicKey.slice(0, 8)}…, status=${status}${model ? `, gpu=${model}` : ""}`
        };
    } catch (err) {
        const msg = err?.message ?? String(err);
        return {
            status: "fail",
            summary: "signed `me` call failed",
            details: msg,
            hint: msg.includes("not found") || msg.includes("404")
                ? "run `infernet register` to create the row"
                : "check `infernet logs` and the control plane logs"
        };
    }
}

// ---------------------------------------------------------------------------
// 6. End-to-end inference
// ---------------------------------------------------------------------------
async function checkEndToEnd(config, { url, model, timeoutMs = 30_000 }) {
    if (!url) return { status: "skip", summary: "no URL — skipped" };

    const messages = [{ role: "user", content: "ping" }];
    // Retry submit up to 6 times (30s) — on a fresh daemon start the provider
    // row may still show status=unknown until the first heartbeat propagates.
    let job;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            job = await submitChatJob(url, { messages, model, maxTokens: 8 });
            break;
        } catch (err) {
            const msg = err?.message ?? String(err);
            if (msg.includes("503") || msg.includes("no live providers")) {
                if (attempt < 5) {
                    await new Promise((r) => setTimeout(r, 5000));
                    continue;
                }
            }
            return {
                status: "fail",
                summary: `POST /api/chat failed: ${msg}`,
                hint: "check `checkControlPlane` above; verify /api/chat is enabled"
            };
        }
    }
    if (!job) {
        return {
            status: "fail",
            summary: "no live providers available after 30s",
            hint: "daemon may not have heartbeated yet — re-run doctor in a minute"
        };
    }

    const ctrl = new AbortController();
    const deadline = setTimeout(() => ctrl.abort(), timeoutMs);

    let firstToken = null;
    let done = null;
    let errorEv = null;
    const start = Date.now();
    try {
        for await (const ev of streamChatEvents(url, job.streamUrl, { signal: ctrl.signal })) {
            if (ev.event === "token" && firstToken == null) firstToken = Date.now() - start;
            if (ev.event === "done") { done = ev.data; break; }
            if (ev.event === "error") { errorEv = ev.data; break; }
        }
    } catch (err) {
        clearTimeout(deadline);
        return {
            status: "fail",
            summary: ctrl.signal.aborted ? `timed out after ${timeoutMs}ms` : `stream failed: ${err?.message ?? err}`,
            hint: "no provider may be online for the requested model — try without --model"
        };
    } finally {
        clearTimeout(deadline);
    }

    if (errorEv) {
        return {
            status: "fail",
            summary: `error event: ${errorEv?.message ?? "unknown"}`,
            hint: "check the daemon log on the provider"
        };
    }
    if (!done) {
        return { status: "fail", summary: "stream ended without `done`", hint: "verify the SSE route is forwarding events" };
    }
    const total = Date.now() - start;
    return {
        status: "ok",
        summary: `routed via=${job.source}${job.provider ? `, provider=${job.provider.name ?? job.provider.nodeId}` : ""}, first token ${firstToken ?? "?"}ms, total ${total}ms`
    };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
export default async function doctor(args) {
    if (args.has("help") || args.has("h")) {
        process.stdout.write(HELP);
        return 0;
    }
    const skipE2E = args.has("skip-e2e");
    const jsonMode = args.has("json");
    const urlOverride = args.get("url") ? String(args.get("url")) : null;
    const modelOverride = args.get("model") ? String(args.get("model")) : null;

    const results = [];
    const checks = ["Local config", "Engine", "Control plane", "Daemon", "Provider row", "End-to-end"];
    if (skipE2E) checks.pop();

    process.stdout.write(`\n${C.bold}infernet doctor${C.reset}\n\n`);

    // 1. Config
    const cfgResult = await checkConfig();
    if (!jsonMode) printCheck(1, checks.length, "Local config", cfgResult);
    results.push({ name: "Local config", ...cfgResult });
    const config = cfgResult.config ?? null;

    // 2. Engine
    const engineResult = await checkEngine(config ?? {});
    if (!jsonMode) printCheck(2, checks.length, "Engine", engineResult);
    results.push({ name: "Engine", ...engineResult });

    // 3. Control plane
    const url = urlOverride ?? config?.controlPlane?.url ?? null;
    const cpResult = await checkControlPlane(url);
    if (!jsonMode) printCheck(3, checks.length, "Control plane", cpResult);
    results.push({ name: "Control plane", ...cpResult });

    // 4. Daemon
    const daemonResult = await checkDaemon();
    if (!jsonMode) printCheck(4, checks.length, "Daemon", daemonResult);
    results.push({ name: "Daemon", ...daemonResult });

    // 5. Provider row
    const provResult = config
        ? await checkProviderRow(config)
        : { status: "skip", summary: "no config — skipped" };
    if (!jsonMode) printCheck(5, checks.length, "Provider row", provResult);
    results.push({ name: "Provider row", ...provResult });

    // 6. End-to-end
    let e2eResult = { status: "skip", summary: "skipped" };
    if (!skipE2E) {
        const model = modelOverride ?? config?.engine?.model ?? null;
        e2eResult = await checkEndToEnd(config ?? {}, { url, model });
        if (!jsonMode) printCheck(6, checks.length, "End-to-end", e2eResult);
        results.push({ name: "End-to-end", ...e2eResult });
    }

    if (jsonMode) {
        for (const r of results) {
            const { config: _drop, ...clean } = r;
            process.stdout.write(JSON.stringify(clean) + "\n");
        }
    }

    const failed = results.filter((r) => r.status === "fail").length;
    const warned = results.filter((r) => r.status === "warn").length;

    if (!jsonMode) {
        process.stdout.write("\n");
        if (failed === 0 && warned === 0) {
            process.stdout.write(`${C.green}${C.bold}All checks passed.${C.reset}\n`);
        } else if (failed === 0) {
            process.stdout.write(`${C.yellow}${warned} warning${warned === 1 ? "" : "s"}, no failures.${C.reset}\n`);
        } else {
            process.stdout.write(`${C.red}${failed} check${failed === 1 ? "" : "s"} failed.${C.reset}\n`);
        }
    }
    return failed === 0 ? 0 : 1;
}
