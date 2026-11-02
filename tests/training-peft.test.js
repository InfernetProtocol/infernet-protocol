import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPeftBackend, createTrainer, PEFT_KINDS, peftGenerate } from "../packages/training/src/index.js";

// A stand-in "python" that ignores its runner argument and prints what the
// real runner prints: v1 events on stdout, logs on stderr, noise in between.
async function fakePython(script) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "peft-test-"));
    const file = path.join(dir, "python");
    await writeFile(file, `#!/bin/sh\n${script}\n`);
    await chmod(file, 0o755);
    return file;
}

async function collect(run) {
    const out = [];
    for await (const ev of run.stream) out.push(ev);
    return out;
}

const JOB = { kind: "lora", base_model: "tiny", dataset: { url: "d.jsonl" }, output: { destination_url: "out" } };

describe("peft training backend", () => {
    it("relays the runner's v1 events and drops anything else", async () => {
        const python = await fakePython([
            `echo '{"v":1,"type":"meta","id":"x","backend":"peft"}'`,
            `echo 'Loading weights: 100%'`,
            `echo '{"v":1,"type":"step","id":"x","step":1,"total_steps":2,"loss":2.5}'`,
            `echo 'a log line' 1>&2`,
            `echo '{"v":1,"type":"checkpoint","id":"x","step":2,"model":"sha256:abc"}'`,
            `echo '{"v":1,"type":"done","id":"x","reason":"complete","final_step":2}'`
        ].join("\n"));
        const run = createPeftBackend({ python }).start({ config: JOB, id: "job-1" });
        const events = await collect(run);
        expect(events.map((e) => e.type)).toEqual(["meta", "step", "checkpoint", "done"]);
        expect(events.every((e) => e.id === "job-1")).toBe(true);
        expect(events.at(-1).reason).toBe("complete");
    });

    it("a runner that dies without done ends in error + done:error", async () => {
        const python = await fakePython(`echo '{"v":1,"type":"meta","id":"x"}'\necho 'Traceback: boom' 1>&2\nexit 3`);
        const events = await collect(createPeftBackend({ python }).start({ config: JOB }));
        expect(events.map((e) => e.type)).toEqual(["meta", "error", "done"]);
        expect(events[1].message).toContain("boom");
        expect(events[2].reason).toBe("error");
    });

    it("refuses a job that is not a text job", async () => {
        const python = await fakePython("exit 0");
        const events = await collect(createPeftBackend({ python }).start({ config: { ...JOB, kind: "temporal-policy" } }));
        expect(events.map((e) => e.type)).toEqual(["error", "done"]);
        expect(events[0].code).toBe("E_BAD_JOB");
    });

    it("peftGenerate returns the runner's answer and surfaces its error", async () => {
        const ok = await fakePython(`echo 'Loading weights'\necho '{"v":1,"type":"answer","text":"Charge for value.","tokens":4}'`);
        const res = await peftGenerate({ request: { adapter_dir: "a", messages: [{ role: "user", content: "hi" }] }, python: ok });
        expect(res.text).toBe("Charge for value.");
        const bad = await fakePython(`echo '{"v":1,"type":"error","message":"no adapter"}'\nexit 1`);
        await expect(peftGenerate({ request: {}, python: bad })).rejects.toThrow("no adapter");
    });

    it("is selectable by name and knows its kinds", async () => {
        expect((await createTrainer({ backend: "peft" })).kind).toBe("peft");
        expect(PEFT_KINDS).toContain("lora");
    });
});
