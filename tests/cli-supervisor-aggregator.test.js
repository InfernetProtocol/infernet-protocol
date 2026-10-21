import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
    EXIT_RESTART,
    isSupervised,
    nextBackoff,
    runSupervisor,
    shouldRestart
} from "../apps/cli/lib/supervisor.js";
import { parseMultiaddr, probePeer, runProbeRound } from "../apps/cli/lib/aggregator.js";
import { buildLaunchdPlist, buildServiceUnit } from "../apps/cli/commands/service.js";

describe("supervisor policy", () => {
    it("restarts on crashes and kills, not on a clean stop", () => {
        expect(shouldRestart(0, null)).toBe(false);
        expect(shouldRestart(1, null)).toBe(true);
        expect(shouldRestart(EXIT_RESTART, null)).toBe(true);
        expect(shouldRestart(null, "SIGKILL")).toBe(true);
    });

    it("backs off 1 s doubling to 60 s, and resets after a healthy run", () => {
        expect(nextBackoff(0, 0)).toBe(1000);
        expect(nextBackoff(1000, 500)).toBe(2000);
        expect(nextBackoff(32000, 500)).toBe(60000);
        expect(nextBackoff(60000, 500)).toBe(60000);
        expect(nextBackoff(60000, 11 * 60_000)).toBe(1000);
    });

    it("knows when something will restart the daemon", () => {
        expect(isSupervised({})).toBe(false);
        expect(isSupervised({ INFERNET_SUPERVISED: "1" })).toBe(true);
        expect(isSupervised({ INVOCATION_ID: "abc" })).toBe(true);
        expect(isSupervised({ XPC_SERVICE_NAME: "com.infernetprotocol.node" })).toBe(true);
        expect(isSupervised({ XPC_SERVICE_NAME: "com.apple.Terminal" })).toBe(false);
    });
});

describe("runSupervisor", () => {
    let dir;
    let argv1;
    let xdg;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "infernet-sup-"));
        argv1 = process.argv[1];
        xdg = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = dir;
    });
    afterAll(() => {
        process.argv[1] = argv1;
        if (xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = xdg;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("restarts a crashing daemon, restarts on 75 at once, and stops on exit 0", async () => {
        // Stub daemon: run 1 crashes, run 2 asks for a restart (update), run 3 stops cleanly.
        const runs = path.join(dir, "runs");
        const stub = path.join(dir, "stub.mjs");
        fs.writeFileSync(stub, `
import fs from "node:fs";
const f = ${JSON.stringify(runs)};
const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1;
fs.writeFileSync(f, String(n));
if (process.env.INFERNET_SUPERVISED !== "1" || !process.argv.includes("--foreground")) process.exit(9);
process.exit(n === 1 ? 1 : n === 2 ? ${EXIT_RESTART} : 0);
`);
        process.argv[1] = stub;
        const t0 = Date.now();
        await runSupervisor([]);
        expect(Number(fs.readFileSync(runs, "utf8"))).toBe(3);
        expect(Date.now() - t0).toBeLessThan(8000);
        expect(fs.existsSync(path.join(dir, "infernet", "supervisor.pid"))).toBe(false);
    }, 15000);
});

describe("aggregator probes", () => {
    let server;
    let port;
    beforeAll(async () => {
        // Same newline-JSON protocol as the daemon's P2P listener (start.js).
        server = net.createServer((sock) => {
            sock.setEncoding("utf8");
            sock.on("data", (d) => {
                const msg = JSON.parse(d.split("\n")[0]);
                if (msg.cmd === "info") sock.write(JSON.stringify({ ok: true, data: { node_id: "provider-abc", role: "provider" } }) + "\n");
            });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        port = server.address().port;
    });
    afterAll(() => server.close());

    it("parses multiaddrs", () => {
        expect(parseMultiaddr("/ip4/1.2.3.4/tcp/46337")).toEqual({ host: "1.2.3.4", port: 46337 });
        expect(parseMultiaddr("/dns4/node.example/tcp/8080")).toEqual({ host: "node.example", port: 8080 });
        expect(parseMultiaddr("/ip4/1.2.3.4/udp/1")).toBeNull();
        expect(parseMultiaddr("/ip4/1.2.3.4/tcp/70000")).toBeNull();
    });

    it("reaches a live node and reports its node_id", async () => {
        const r = await probePeer({ host: "127.0.0.1", port });
        expect(r).toMatchObject({ reachable: true, node_id: "provider-abc", error: null });
        expect(r.rtt_ms).toBeGreaterThanOrEqual(0);
    });

    it("reports a closed port as unreachable", async () => {
        const closed = net.createServer();
        await new Promise((r) => closed.listen(0, "127.0.0.1", r));
        const p = closed.address().port;
        await new Promise((r) => closed.close(r));
        const r = await probePeer({ host: "127.0.0.1", port: p }, { timeoutMs: 2000 });
        expect(r.reachable).toBe(false);
        expect(r.error).toBe("ECONNREFUSED");
    });

    it("runs a round: fetch peers, probe, sign and report", async () => {
        const sent = [];
        const client = { signedFetch: async (p, body) => { sent.push([p, body]); return { stored: body.probes.length }; } };
        const fetchImpl = async (url) => {
            expect(url).toBe("https://cp.example/api/peers");
            return new Response(JSON.stringify({ data: [
                { pubkey: "a".repeat(64), multiaddr: `/ip4/127.0.0.1/tcp/${port}` },
                { pubkey: "b".repeat(64), multiaddr: "garbage" }
            ] }), { status: 200 });
        };
        const out = await runProbeRound({ client, controlPlaneUrl: "https://cp.example/", fetchImpl });
        expect(out).toEqual({ probed: 1, reachable: 1 });
        expect(sent[0][0]).toBe("/api/v1/node/aggregator/probes");
        expect(sent[0][1].probes[0]).toMatchObject({ pubkey: "a".repeat(64), reachable: true, node_id: "provider-abc" });
    });

    it("never throws when the control plane is down", async () => {
        const out = await runProbeRound({
            client: { signedFetch: async () => { throw new Error("no"); } },
            controlPlaneUrl: "https://cp.example",
            fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
        });
        expect(out).toMatchObject({ probed: 0, reachable: 0, error: "ECONNREFUSED" });
    });
});

describe("service units", () => {
    it("systemd unit marks the daemon supervised and never stops retrying", () => {
        const unit = buildServiceUnit({ nodeBin: "/usr/bin/node", cliEntry: "/opt/cli/index.js" });
        expect(unit).toContain("Environment=INFERNET_SUPERVISED=1");
        expect(unit).toContain("StartLimitIntervalSec=0");
        expect(unit).toContain("Restart=on-failure");
    });

    it("launchd plist restarts on non-zero exit and starts at login", () => {
        const plist = buildLaunchdPlist({ nodeBin: "/opt/homebrew/bin/node", cliEntry: "/x/index.js", logPath: "/tmp/a&b.log" });
        expect(plist).toContain("<string>com.infernetprotocol.node</string>");
        expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
        expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
        expect(plist).toContain("<string>--foreground</string>");
        expect(plist).toContain("/tmp/a&amp;b.log");
    });
});
