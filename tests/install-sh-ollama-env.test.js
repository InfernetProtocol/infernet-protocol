import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 2026-11-18: the house 9B thrashed a 12 GB GPU until Ollama ran with flash
// attention + q8_0 KV cache. install.sh writes those as an ollama.service
// drop-in, but never over keys the operator already set in the unit.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(path.join(repoRoot, "install.sh"), "utf8");
const grab = (name) => script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}\\n`, "m"))[0];
const fns = `OLLAMA_DROPIN=/etc/systemd/system/ollama.service.d/infernet-memory.conf\n${grab("ollama_operator_env_keys")}\n${grab("ollama_memory_dropin")}\n`;

function dropinFor(unitCat) {
    const sh = `set -eu\n${fns}\nollama_memory_dropin "$(printf '%s\\n' "$UNIT" | ollama_operator_env_keys)"\n`;
    return execFileSync("sh", ["-c", sh], { encoding: "utf8", env: { ...process.env, UNIT: unitCat } }).trim();
}

const BASE = `# /etc/systemd/system/ollama.service
[Service]
ExecStart=/usr/local/bin/ollama serve
Environment="PATH=/usr/local/bin:/usr/bin"`;

describe("install.sh Ollama memory drop-in", () => {
    it("sets both keys on a stock ollama.service", () => {
        const out = dropinFor(BASE);
        expect(out).toContain('Environment="OLLAMA_FLASH_ATTENTION=1" "OLLAMA_KV_CACHE_TYPE=q8_0"');
        expect(out).toContain("[Service]");
    });

    it("leaves a key the operator set in the unit alone", () => {
        const out = dropinFor(`${BASE}\nEnvironment="OLLAMA_HOST=0.0.0.0" "OLLAMA_KV_CACHE_TYPE=f16"`);
        expect(out).toContain('Environment="OLLAMA_FLASH_ATTENTION=1"');
        expect(out).not.toContain("KV_CACHE");
    });

    it("counts operator drop-ins, not our own", () => {
        const out = dropinFor(`${BASE}
# /etc/systemd/system/ollama.service.d/override.conf
[Service]
Environment="OLLAMA_FLASH_ATTENTION=0"
# /etc/systemd/system/ollama.service.d/infernet-memory.conf
[Service]
Environment="OLLAMA_FLASH_ATTENTION=1" "OLLAMA_KV_CACHE_TYPE=q8_0"`);
        expect(out).toContain('Environment="OLLAMA_KV_CACHE_TYPE=q8_0"');
        expect(out).not.toContain("FLASH_ATTENTION");
    });

    it("writes nothing when the operator set both", () => {
        expect(dropinFor(`${BASE}\nEnvironment=OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q4_0`)).toBe("");
    });

    it("runs from main after the baseline model", () => {
        expect(script).toMatch(/ensure_cpu_baseline_model\n[\s\S]*?\n    ensure_ollama_memory_env\n/);
    });
});
