/**
 * `infernet service` — userland systemd integration for the daemon.
 *
 * An optional alternative to running `infernet start` directly /
 * `infernet start` (detached). When installed, systemd manages the
 * daemon: auto-restart on crash, optional auto-start at boot, logs
 * to journald. Runs as the unprivileged user — never touches /etc
 * or anything system-wide. Service file lives under
 * ~/.config/systemd/user/infernet.service.
 *
 * Linux uses systemd --user; macOS uses a launchd LaunchAgent
 * (~/Library/LaunchAgents/com.infernetprotocol.node.plist). Elsewhere
 * `infernet start` runs the built-in supervisor (lib/supervisor.js).
 *
 * Both units restart on any non-zero exit (crash, OOM kill, or exit 75 from
 * a self-update) and stay down after a clean `infernet stop` (exit 0).
 *
 * Usage:
 *   infernet service install        write the unit file + daemon-reload
 *   infernet service uninstall      stop / disable / delete the unit file
 *   infernet service enable         systemctl --user enable --now infernet
 *   infernet service disable        systemctl --user disable --now infernet
 *   infernet service status         systemctl --user status infernet
 *   infernet service logs           journalctl --user -u infernet -f
 *   infernet service unit           print the unit file we'd write (no side effects)
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { question } from "../lib/prompt.js";

export const SERVICE_NAME = "infernet";
export const LAUNCHD_LABEL = "com.infernetprotocol.node";

const HELP = `infernet service — manage the userland systemd unit

Usage:
  infernet service <subcommand> [flags]

Subcommands:
  install         Write ~/.config/systemd/user/${SERVICE_NAME}.service and daemon-reload
  uninstall       Stop, disable, and remove the unit file
  enable          systemctl --user enable --now ${SERVICE_NAME}
  disable         systemctl --user disable --now ${SERVICE_NAME}
  status          systemctl --user status ${SERVICE_NAME}
  logs            journalctl --user -u ${SERVICE_NAME} -f
  unit            Print the unit file that would be written (no side effects)

Flags:
  --confirm       Skip the install / uninstall confirmation prompt.
  --enable-after  After install, also enable + start. Default: no.
  -h, --help      Show this help.

Notes:
  - Linux: systemd --user. macOS: launchd LaunchAgent (${"com.infernetprotocol.node"}).
  - Type=simple. ExecStart calls 'infernet start --foreground' so
    systemd owns the process (no double-fork).
  - Logs go to journald; tail with 'journalctl --user -u ${SERVICE_NAME} -f'
    or 'infernet service logs'.
  - For boot persistence on a system without a logged-in user
    session, run 'loginctl enable-linger $USER' once.
`;

export function getServicePath() {
    if (process.platform === "darwin") return getLaunchdPath();
    return path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

export function getLaunchdPath() {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function xmlEscape(v) {
    return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * LaunchAgent plist. KeepAlive.SuccessfulExit=false restarts on any non-zero
 * exit and leaves a clean `infernet stop` (exit 0) alone; RunAtLoad starts it
 * at login. Pure function.
 *
 * @param {{ nodeBin: string, cliEntry: string, logPath: string, pathEnv?: string }} args
 */
export function buildLaunchdPlist({ nodeBin, cliEntry, logPath, pathEnv } = {}) {
    if (!nodeBin) throw new Error("buildLaunchdPlist: nodeBin is required");
    if (!cliEntry) throw new Error("buildLaunchdPlist: cliEntry is required");
    const args = [nodeBin, cliEntry, "start", "--foreground"]
        .map((a) => `        <string>${xmlEscape(a)}</string>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>INFERNET_SUPERVISED</key>
        <string>1</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PATH</key>
        <string>${xmlEscape(pathEnv ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Render the unit file contents from inputs. Pure function — easy to
 * unit-test, no side effects, no environment lookups.
 *
 * @param {{ nodeBin: string, cliEntry: string, environment?: Record<string,string>, description?: string }} args
 */
export function buildServiceUnit({ nodeBin, cliEntry, environment = {}, description } = {}) {
    if (!nodeBin) throw new Error("buildServiceUnit: nodeBin is required");
    if (!cliEntry) throw new Error("buildServiceUnit: cliEntry is required");

    const desc = description ?? "Infernet Protocol provider daemon";
    const envLines = Object.entries(environment)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `Environment=${k}=${v}`);

    return [
        "[Unit]",
        `Description=${desc}`,
        "Documentation=https://infernetprotocol.com",
        "After=network-online.target",
        "Wants=network-online.target",
        // Never give up restarting: a node that crash-loops while the network is
        // down must still come back once it returns.
        "StartLimitIntervalSec=0",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${nodeBin} ${cliEntry} start --foreground`,
        "Restart=on-failure",
        "RestartSec=10",
        "Environment=NODE_ENV=production",
        // Self-update exits 75 under a supervisor instead of re-execing (lib/supervisor.js).
        "Environment=INFERNET_SUPERVISED=1",
        ...envLines,
        "",
        "[Install]",
        "WantedBy=default.target",
        ""
    ].join("\n");
}

function resolveCliEntry() {
    // service.js lives at apps/cli/commands/service.js. The CLI entry
    // is one directory up at apps/cli/index.js.
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "..", "index.js");
}

/** True when this host can run the unit: systemd --user on Linux, launchd on macOS. */
export function serviceSupported() {
    if (process.platform === "darwin") return true;
    if (process.platform !== "linux") return false;
    const uid = process.getuid?.();
    return fsSync.existsSync("/run/systemd/system") && uid != null && fsSync.existsSync(`/run/user/${uid}/bus`);
}

/** A system-wide infernet.service (our fleet boxes, root installs) owns the daemon already. */
export function systemUnitPresent() {
    if (process.platform !== "linux") return false;
    const r = spawnSync("systemctl", ["is-enabled", "--quiet", "infernet.service"], { stdio: "ignore" });
    return r.status === 0
        || fsSync.existsSync("/etc/systemd/system/infernet.service")
        || fsSync.existsSync("/lib/systemd/system/infernet.service");
}

function launchctl(args) {
    return spawnSync("launchctl", args, { stdio: "pipe" });
}

/**
 * Install (if missing) and start the supervisor unit for this platform, so the
 * daemon survives crashes, reboots and self-updates. Never throws.
 *
 * @returns {Promise<{ ok: boolean, how?: string, reason?: string }>}
 */
export async function ensureService({ log = () => {} } = {}) {
    try {
        if (!serviceSupported()) return { ok: false, reason: "no systemd --user or launchd here" };
        if (systemUnitPresent()) return { ok: false, reason: "system infernet.service manages the daemon" };
        const target = getServicePath();
        const cliEntry = resolveCliEntry();
        await fs.mkdir(path.dirname(target), { recursive: true });

        if (process.platform === "darwin") {
            const { getDaemonLogPath } = await import("../lib/config.js");
            const plist = buildLaunchdPlist({
                nodeBin: process.execPath, cliEntry, logPath: getDaemonLogPath(), pathEnv: process.env.PATH
            });
            await fs.writeFile(target, plist, { mode: 0o644 });
            const domain = `gui/${process.getuid()}`;
            launchctl(["bootout", `${domain}/${LAUNCHD_LABEL}`]);
            const r = launchctl(["bootstrap", domain, target]);
            if (r.status !== 0) {
                const legacy = launchctl(["load", "-w", target]);
                if (legacy.status !== 0) return { ok: false, reason: `launchctl: ${String(r.stderr || legacy.stderr).trim()}` };
            }
            launchctl(["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);
            log(`launchd agent ${LAUNCHD_LABEL} installed and started`);
            return { ok: true, how: "launchd" };
        }

        await fs.writeFile(target, buildServiceUnit({ nodeBin: process.execPath, cliEntry }), { mode: 0o644 });
        runSystemctl(["daemon-reload"], { inherit: false });
        const en = runSystemctl(["enable", SERVICE_NAME], { inherit: false });
        if (en.status !== 0) return { ok: false, reason: `systemctl --user enable: ${String(en.stderr).trim()}` };
        const rs = runSystemctl(["restart", SERVICE_NAME], { inherit: false });
        if (rs.status !== 0) return { ok: false, reason: `systemctl --user restart: ${String(rs.stderr).trim()}` };
        // Keep running after logout and start at boot. Allowed for your own user on
        // most distros; harmless when it is refused.
        const linger = spawnSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "pipe" });
        log(linger.status === 0
            ? "systemd user unit installed, enabled and started (linger on: survives logout and reboot)"
            : "systemd user unit installed, enabled and started (run `loginctl enable-linger $USER` to survive logout)");
        return { ok: true, how: "systemd" };
    } catch (err) {
        return { ok: false, reason: err?.message ?? String(err) };
    }
}

function ensureLinux() {
    if (process.platform === "darwin") return true;
    if (process.platform !== "linux") {
        process.stderr.write(
            `error: 'infernet service' is Linux-only (your platform: ${process.platform}).\n` +
            `       use 'infernet start' directly, or wire your own supervisor (launchd, sc, etc.)\n`
        );
        return false;
    }
    return true;
}

function runSystemctl(args, { inherit = true } = {}) {
    const opts = inherit ? { stdio: "inherit" } : { stdio: "pipe" };
    return spawnSync("systemctl", ["--user", ...args], opts);
}

async function installCmd(args) {
    if (!ensureLinux()) return 2;
    const yes = args.has("confirm") || args.has("yes");
    const enableAfter = args.has("enable-after");

    const unit = buildServiceUnit({
        nodeBin: process.execPath,
        cliEntry: resolveCliEntry()
    });
    const target = getServicePath();

    process.stdout.write("\nWill write:\n");
    process.stdout.write("─".repeat(60) + "\n");
    process.stdout.write(unit);
    process.stdout.write("─".repeat(60) + "\n\n");
    process.stdout.write(`To: ${target}\n\n`);

    if (!yes) {
        const ans = await question("Install?", { default: "y" });
        if (!ans.toLowerCase().startsWith("y")) {
            process.stdout.write("aborted\n");
            return 1;
        }
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, unit, { mode: 0o644 });
    process.stdout.write(`✓ wrote ${target}\n`);

    const reload = runSystemctl(["daemon-reload"]);
    if (reload.status !== 0) {
        process.stderr.write("warning: 'systemctl --user daemon-reload' failed — your changes may not be picked up until the next reload.\n");
    } else {
        process.stdout.write("✓ systemctl --user daemon-reload\n");
    }

    if (enableAfter) {
        const enabled = runSystemctl(["enable", "--now", SERVICE_NAME]);
        if (enabled.status === 0) {
            process.stdout.write("✓ enabled and started\n");
        } else {
            process.stderr.write("warning: enable --now failed; run manually with 'systemctl --user enable --now infernet'\n");
        }
    } else {
        process.stdout.write("\nNext:\n");
        process.stdout.write("  systemctl --user enable --now infernet     # auto-start at login + run now\n");
        process.stdout.write("  systemctl --user status infernet            # check status\n");
        process.stdout.write("  journalctl --user -u infernet -f            # tail logs\n");
        process.stdout.write("  loginctl enable-linger $USER                # (one-time) keep running when not logged in\n");
    }
    return 0;
}

async function uninstallCmd(args) {
    if (!ensureLinux()) return 2;
    const yes = args.has("confirm") || args.has("yes");
    const target = getServicePath();

    let exists = true;
    try { await fs.access(target); } catch { exists = false; }

    if (!exists) {
        process.stdout.write(`No service file at ${target}; nothing to do.\n`);
        return 0;
    }

    process.stdout.write(`Will stop / disable / delete: ${target}\n`);
    if (!yes) {
        const ans = await question("Uninstall?", { default: "y" });
        if (!ans.toLowerCase().startsWith("y")) {
            process.stdout.write("aborted\n");
            return 1;
        }
    }

    runSystemctl(["disable", "--now", SERVICE_NAME], { inherit: false });
    try {
        await fs.unlink(target);
        process.stdout.write(`✓ removed ${target}\n`);
    } catch (err) {
        process.stderr.write(`failed to remove unit file: ${err?.message ?? err}\n`);
        return 1;
    }
    runSystemctl(["daemon-reload"], { inherit: false });
    process.stdout.write("✓ uninstalled\n");
    return 0;
}

function spawnInherited(bin, argv) {
    return new Promise((resolve) => {
        const child = spawn(bin, argv, { stdio: "inherit" });
        child.on("exit", (code) => resolve(code ?? 0));
        child.on("error", () => resolve(1));
    });
}

async function darwinCmd(sub) {
    const domain = `gui/${process.getuid()}`;
    const target = getLaunchdPath();
    switch (sub) {
        case "install":
        case "enable": {
            const res = await ensureService({ log: (m) => process.stdout.write(`✓ ${m}\n`) });
            if (!res.ok) process.stderr.write(`error: ${res.reason}\n`);
            return res.ok ? 0 : 1;
        }
        case "disable":
        case "uninstall":
            launchctl(["bootout", `${domain}/${LAUNCHD_LABEL}`]);
            if (sub === "uninstall") { try { await fs.unlink(target); } catch { /* not installed */ } }
            process.stdout.write(`✓ ${sub === "uninstall" ? "removed" : "stopped"} ${LAUNCHD_LABEL}\n`);
            return 0;
        case "status":
            return spawnInherited("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`]);
        case "logs": {
            const { getDaemonLogPath } = await import("../lib/config.js");
            return spawnInherited("tail", ["-f", getDaemonLogPath()]);
        }
        case "unit": {
            const { getDaemonLogPath } = await import("../lib/config.js");
            process.stdout.write(buildLaunchdPlist({ nodeBin: process.execPath, cliEntry: resolveCliEntry(), logPath: getDaemonLogPath() }));
            return 0;
        }
        default:
            process.stderr.write(HELP);
            return 2;
    }
}

export default async function service(args) {
    if (args.has("help") || args.has("h")) {
        process.stdout.write(HELP);
        return 0;
    }
    const sub = (args.positional ?? [])[0];
    if (process.platform === "darwin") return darwinCmd(sub);
    switch (sub) {
        case "install":   return installCmd(args);
        case "uninstall": return uninstallCmd(args);
        case "enable":
            if (!ensureLinux()) return 2;
            return spawnInherited("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
        case "disable":
            if (!ensureLinux()) return 2;
            return spawnInherited("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
        case "status":
            if (!ensureLinux()) return 2;
            return spawnInherited("systemctl", ["--user", "status", SERVICE_NAME]);
        case "logs":
            if (!ensureLinux()) return 2;
            return spawnInherited("journalctl", ["--user", "-u", SERVICE_NAME, "-f"]);
        case "unit":
            process.stdout.write(buildServiceUnit({
                nodeBin: process.execPath,
                cliEntry: resolveCliEntry()
            }));
            return 0;
        default:
            process.stderr.write(sub
                ? `unknown subcommand: ${sub}\n\n`
                : "error: missing subcommand\n\n");
            process.stderr.write(HELP);
            return 2;
    }
}
