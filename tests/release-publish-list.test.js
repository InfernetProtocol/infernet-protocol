import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `npm i -g @infernetprotocol/cli` resolves every @infernetprotocol/* dependency
// from npm. A workspace package the CLI depends on but release.yml does not
// publish breaks the install with E404 (rpc-adapter, 0.1.45 to 0.1.53).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

const release = read(".github/workflows/release.yml");
const published = new Set([...release.matchAll(/--filter "(@infernetprotocol\/[^"]+)"/g)].map((m) => m[1]));

function workspaceDeps(pkgJsonPath) {
    const pkg = JSON.parse(read(pkgJsonPath));
    return Object.entries(pkg.dependencies ?? {})
        .filter(([name, spec]) => name.startsWith("@infernetprotocol/") && String(spec).startsWith("workspace:"))
        .map(([name]) => name);
}

describe("release.yml publish list", () => {
    it("publishes the CLI", () => {
        expect(published.has("@infernetprotocol/cli")).toBe(true);
    });

    it("publishes every workspace package the CLI depends on", () => {
        const missing = workspaceDeps("apps/cli/package.json").filter((n) => !published.has(n));
        expect(missing).toEqual([]);
    });
});
