import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// bonita 2026-11-02: installed from git while npm lagged, then a later update
// took the npm path (npm had caught up) while infernet.service kept running
// ~/.infernet/source, so the daemon never got the new code.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(path.join(repoRoot, "install.sh"), "utf8");
const fn = script.match(/^existing_git_install_in_use\(\) \{[\s\S]*?^\}\n/m)[0];

function inUse(home) {
    const sh = `${fn}\nSOURCE_DIR="${home}/.infernet/source"; WRAPPER="${home}/.local/bin/infernet"; HOME="${home}"\nexisting_git_install_in_use && echo yes || echo no\n`;
    return execFileSync("sh", ["-c", sh], { encoding: "utf8" }).trim();
}

describe("install.sh keeps an in-use git install on git", () => {
    let home;
    beforeEach(() => {
        home = mkdtempSync(path.join(tmpdir(), "inst-git-"));
        execFileSync("git", ["init", "-q", path.join(home, ".infernet", "source")]);
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("yes when a user unit runs the source checkout", () => {
        const dir = path.join(home, ".config", "systemd", "user");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "infernet.service"), `ExecStart=/bin/bun ${home}/.infernet/source/apps/cli/index.js start --foreground\n`);
        expect(inUse(home)).toBe("yes");
    });

    it("yes when the wrapper runs the source checkout", () => {
        mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
        writeFileSync(path.join(home, ".local", "bin", "infernet"), `#!/bin/sh\nexec bun "${home}/.infernet/source/apps/cli/index.js" "$@"\n`);
        expect(inUse(home)).toBe("yes");
    });

    it("no when nothing uses it (npm installs stay on npm)", () => {
        expect(inUse(home)).toBe("no");
    });
});
