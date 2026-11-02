import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    findGlobalCopies,
    findSourceInstall,
    wrapperTarget,
    planPrune,
    pruneCliCopies,
    copiesUsedByServices,
    copiesUsedByProcesses,
    resolvePathInfernet
} from "../apps/cli/lib/cli-copies.js";
import { RUNNING_VERSION, readRunningVersion, readInstalledVersion } from "../apps/cli/lib/version.js";
import { judgeCliInstall } from "../apps/cli/commands/doctor.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = "@infernetprotocol/cli";

// A fake home shaped like bonita on 2026-11-02: the installer's git checkout
// at ~/.infernet/source (0.1.83), its wrapper at ~/.local/bin/infernet, and a
// stale npm-global 0.1.80 under mise's Node with mise's alias dirs.
function bonitaHome(root, { staleVersion = "0.1.80", sourceVersion = "0.1.83" } = {}) {
    const home = path.join(root, "home");
    const write = (p, s) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s); };
    const pkg = (dir, version) => write(path.join(dir, "package.json"), JSON.stringify({ name: PKG, version }));

    const source = path.join(home, ".infernet", "source", "apps", "cli");
    pkg(source, sourceVersion);
    write(path.join(source, "index.js"), "");

    const nodeDir = path.join(home, ".local", "share", "mise", "installs", "node");
    const real = path.join(nodeDir, "24.18.1");
    const stale = path.join(real, "lib", "node_modules", PKG);
    pkg(stale, staleVersion);
    write(path.join(stale, "index.js"), "");
    mkdirSync(path.join(real, "bin"), { recursive: true });
    symlinkSync(path.join(stale, "index.js"), path.join(real, "bin", "infernet"));
    for (const alias of ["24", "lts"]) symlinkSync("./24.18.1", path.join(nodeDir, alias));

    const bin = path.join(home, ".local", "bin");
    write(path.join(bin, "infernet"), `#!/bin/sh\nif command -v bun >/dev/null 2>&1; then\n    exec bun "${source}/index.js" "$@"\nfi\n`);
    write(path.join(bin, "mise"), "");
    const shims = path.join(home, ".local", "share", "mise", "shims");
    mkdirSync(shims, { recursive: true });
    symlinkSync(path.join(bin, "mise"), path.join(shims, "infernet"));

    const env = { PATH: [shims, bin].join(":"), MISE_INSTALL_PATH: path.join(root, "no-mise") };
    return { home, env, source, stale, real, shims, bin };
}

describe("finding CLI copies", () => {
    let root;
    beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "cli-copies-")); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    it("finds the stale mise copy once despite mise's alias dirs", () => {
        const b = bonitaHome(root);
        const copies = findGlobalCopies({ env: b.env, home: b.home, npmPrefix: null });
        const mine = copies.filter((c) => c.dir.startsWith(b.home));
        expect(mine).toHaveLength(1);
        expect(mine[0].version).toBe("0.1.80");
        expect(mine[0].prefixes).toHaveLength(3);
        expect(mine[0].bins.length).toBeGreaterThanOrEqual(1);
        expect(findSourceInstall({ env: b.env, home: b.home }).version).toBe("0.1.83");
        expect(wrapperTarget({ env: b.env, home: b.home })).toBe(b.source);
    });

    it("reads an npm-path wrapper (exec \"<prefix>/bin/infernet\" \"$@\")", () => {
        const b = bonitaHome(root);
        writeFileSync(path.join(b.bin, "infernet"), `#!/bin/sh\nexec "${path.join(b.real, "bin", "infernet")}" "$@"\n`);
        expect(wrapperTarget({ env: b.env, home: b.home })).toBe(b.stale);
    });

    it("names what `infernet` on PATH runs: the mise shim -> the stale copy", () => {
        const b = bonitaHome(root);
        const copies = findGlobalCopies({ env: b.env, home: b.home, npmPrefix: null }).filter((c) => c.dir.startsWith(b.home));
        const first = resolvePathInfernet({ env: b.env, home: b.home, copies });
        expect(first.via).toBe("mise shim");
        expect(first.dir).toBe(b.stale);
    });
});

describe("pruning CLI copies", () => {
    let root;
    beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "cli-prune-")); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });

    const copy = (dir, version) => ({ kind: "npm-global", dir, version, prefixes: [path.dirname(dir)], bins: [] });

    it("keeps the install, updates a copy a service runs, removes the rest", () => {
        const plan = planPrune({
            copies: [copy("/a", "0.1.84"), copy("/b", "0.1.80"), copy("/c", "0.1.80")],
            keepDirs: ["/a"],
            usedBy: new Map([["/b", "/etc/systemd/system/infernet.service"]]),
            version: "0.1.84"
        });
        expect(plan.keep.map((c) => c.dir)).toEqual(["/a"]);
        expect(plan.update.map((c) => c.dir)).toEqual(["/b"]);
        expect(plan.remove.map((c) => c.dir)).toEqual(["/c"]);
    });

    it("removes the stale npm-global copy and its bin link on a git install", () => {
        const b = bonitaHome(root);
        const copies = findGlobalCopies({ env: b.env, home: b.home, npmPrefix: null }).filter((c) => c.dir.startsWith(b.home));
        const r = pruneCliCopies({ env: b.env, home: b.home, copies, usedBy: new Map() });
        expect(r.removed).toEqual([b.stale]);
        expect(existsSync(b.stale)).toBe(false);
        expect(existsSync(path.join(b.real, "bin", "infernet"))).toBe(false);
        expect(existsSync(path.join(b.source, "package.json"))).toBe(true);
    });

    it("never removes the only CLI (no wrapper, no source install)", () => {
        const b = bonitaHome(root);
        rmSync(path.join(b.home, ".infernet"), { recursive: true });
        rmSync(path.join(b.bin, "infernet"));
        const copies = findGlobalCopies({ env: b.env, home: b.home, npmPrefix: null }).filter((c) => c.dir.startsWith(b.home));
        const r = pruneCliCopies({ env: b.env, home: b.home, copies, usedBy: new Map() });
        expect(r.removed).toEqual([]);
        expect(existsSync(b.stale)).toBe(true);
    });

    it("dry run changes nothing", () => {
        const b = bonitaHome(root);
        const copies = findGlobalCopies({ env: b.env, home: b.home, npmPrefix: null }).filter((c) => c.dir.startsWith(b.home));
        const r = pruneCliCopies({ env: b.env, home: b.home, copies, usedBy: new Map(), dryRun: true });
        expect(r.removed).toEqual([b.stale]);
        expect(existsSync(b.stale)).toBe(true);
    });

    it("protects copies a unit file or a running process starts from", () => {
        const b = bonitaHome(root);
        const copies = findGlobalCopies({ env: b.env, home: b.home, npmPrefix: null }).filter((c) => c.dir.startsWith(b.home));
        const unit = path.join(root, "infernet.service");
        writeFileSync(unit, `ExecStart=/usr/bin/node ${path.join(b.real, "lib", "node_modules", PKG)}/index.js start --foreground\n`);
        expect([...copiesUsedByServices(copies, [unit]).keys()]).toEqual([b.stale]);

        const proc = path.join(root, "proc");
        mkdirSync(path.join(proc, "4242"), { recursive: true });
        writeFileSync(path.join(proc, "4242", "cmdline"), `node\0${b.stale}/index.js\0start\0`);
        expect(copiesUsedByProcesses(copies, { procDir: proc, selfPid: 1 }).get(b.stale)).toBe("running process 4242");
    });
});

describe("version reporting", () => {
    it("RUNNING_VERSION is this code's package.json, not the newest on disk", () => {
        const pkg = JSON.parse(readFileSync(path.join(repoRoot, "apps/cli/package.json"), "utf8"));
        expect(RUNNING_VERSION).toBe(pkg.version);
        expect(readRunningVersion(path.join(repoRoot, "apps/cli"))).toBe(pkg.version);
        expect(readRunningVersion("/nonexistent")).toBe("0.0.0");
    });

    it("readInstalledVersion still sees a newer source checkout (for the updater)", () => {
        const root = mkdtempSync(path.join(tmpdir(), "cli-ver-"));
        try {
            mkdirSync(path.join(root, "source", "apps", "cli"), { recursive: true });
            writeFileSync(path.join(root, "source", "apps", "cli", "package.json"), JSON.stringify({ version: "99.0.0" }));
            const prev = process.env.INFERNET_HOME;
            process.env.INFERNET_HOME = root;
            try { expect(readInstalledVersion()).toBe("99.0.0"); } finally {
                if (prev === undefined) delete process.env.INFERNET_HOME; else process.env.INFERNET_HOME = prev;
            }
            expect(RUNNING_VERSION).not.toBe("99.0.0");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("doctor: CLI install check", () => {
    const running = { version: "0.1.84", dir: "/src/apps/cli" };

    it("passes with one CLI and a daemon on the same version", () => {
        const r = judgeCliInstall({
            running,
            copies: [{ kind: "source", dir: "/src/apps/cli", version: "0.1.84" }],
            wrapper: "/src/apps/cli",
            pathFirst: { path: "/usr/local/bin/infernet", via: "installer wrapper", dir: "/src/apps/cli" },
            daemon: { version: "0.1.84", cliDir: "/src/apps/cli" }
        });
        expect(r.status).toBe("ok");
    });

    it("fails on bonita's skew: a stale npm copy first on PATH", () => {
        const r = judgeCliInstall({
            running,
            copies: [
                { kind: "source", dir: "/src/apps/cli", version: "0.1.84" },
                { kind: "npm-global", dir: "/mise/node/24.18.1/lib/node_modules/@infernetprotocol/cli", version: "0.1.80" }
            ],
            wrapper: "/src/apps/cli",
            pathFirst: { path: "/mise/shims/infernet", via: "mise shim", dir: "/mise/node/24.18.1/lib/node_modules/@infernetprotocol/cli" },
            daemon: { version: "0.1.84" }
        });
        expect(r.status).toBe("fail");
        expect(r.summary).toMatch(/2 CLI versions installed \(0\.1\.84, 0\.1\.80\)/);
        expect(r.summary).toMatch(/on PATH runs v0\.1\.80/);
        expect(r.hint).toMatch(/infernet upgrade/);
    });

    it("fails when the daemon runs another version, or is too old to say", () => {
        const one = [{ kind: "source", dir: "/src/apps/cli", version: "0.1.84" }];
        expect(judgeCliInstall({ running, copies: one, wrapper: "/src/apps/cli", daemon: { version: "0.1.83" } }).summary)
            .toMatch(/daemon runs v0\.1\.83, CLI is v0\.1\.84/);
        expect(judgeCliInstall({ running, copies: one, wrapper: "/src/apps/cli", daemon: { version: null } }).status).toBe("fail");
    });
});
