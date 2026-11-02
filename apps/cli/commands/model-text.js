/**
 * Text fine-tunes (workload infernet.text.train): `infernet model train --job
 * <job.json>` with `kind: "lora"` runs the @infernetprotocol/training peft
 * backend instead of the temporal runtime.
 *
 *   infernet model runtime setup --peft [--accelerator cpu|cuda] --yes
 *   infernet model runtime status --peft [--json]
 *   infernet model train --job job.json [--json]
 *
 * With --json, stdout is the training-protocol v1 event stream, one JSON object
 * per line, ending with `done` (what c0mpute's text worker relays to the
 * buyer). Without it, a progress line per step on stderr and a summary.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import {
    createPeftBackend,
    PEFT_KINDS,
    peftRuntimeStatus,
    setupPeftRuntime
} from "@infernetprotocol/training";

export const TEXT_HELP = `
Text fine-tunes (workload infernet.text.train):
  infernet model runtime setup --peft [--accelerator cpu|cuda] [--yes]
                                         Install the peft runtime (PyTorch + transformers
                                         + peft in their own venv, ~1 GB on CPU).
  infernet model runtime status --peft [--json]
  infernet model train --job <job.json> [--json]
                                         LoRA-tune job.base_model on job.dataset (jsonl of
                                         {title, text}); --json streams v1 events.
`;

export function isTextJob(job) {
    return Boolean(job && PEFT_KINDS.includes(job.kind));
}

export async function cmdTextRuntime(args) {
    const sub = args.positional?.[1] ?? "status";
    const accelerator = args.has("accelerator") ? args.get("accelerator") : "cpu";
    if (sub === "setup") {
        if (!args.has("yes") && !args.has("y") && process.env.INFERNET_NONINTERACTIVE !== "1") {
            process.stdout.write(`This installs the peft runtime: a Python venv with PyTorch (${accelerator}), transformers and peft (about ${accelerator === "cuda" ? "5" : "1"} GB). Re-run with --yes to proceed.\n`);
            return 1;
        }
        const rt = await setupPeftRuntime({ accelerator, log: (l) => process.stderr.write(`${l}\n`) });
        process.stdout.write(`installed: ${rt.python} (${rt.accelerator})\n`);
        return 0;
    }
    const st = await peftRuntimeStatus();
    if (args.has("json")) process.stdout.write(`${JSON.stringify(st ? { installed: true, ...st } : { installed: false })}\n`);
    else process.stdout.write(st ? `peft runtime: torch ${st.torch}, transformers ${st.transformers}, peft ${st.peft}, cuda ${st.cuda}\n  ${st.python}\n` : "peft runtime: not installed (infernet model runtime setup --peft --yes)\n");
    return st ? 0 : 1;
}

export async function cmdTextTrain(args, jobPath) {
    const file = path.resolve(jobPath);
    const job = JSON.parse(await readFile(file, "utf8"));
    if (!isTextJob(job)) {
        process.stderr.write(`error: ${jobPath} is not a text job (kind must be one of ${PEFT_KINDS.join(", ")})\n`);
        return 2;
    }
    const json = args.has("json");
    const backend = createPeftBackend();
    const run = backend.start({ config: job, jobPath: file });
    const onSignal = () => run.cancel();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    let done = null;
    let checkpoint = null;
    for await (const ev of run.stream) {
        if (json) process.stdout.write(`${JSON.stringify(ev)}\n`);
        else if (ev.type === "step") process.stderr.write(`step ${ev.step}/${ev.total_steps ?? "?"}  loss ${ev.loss}\n`);
        else if (ev.type === "eval") process.stderr.write(`eval @${ev.step}: ${JSON.stringify(ev.metrics)}\n`);
        else if (ev.type === "error") process.stderr.write(`error: ${ev.message}\n`);
        if (ev.type === "checkpoint") checkpoint = ev;
        if (ev.type === "done") done = ev;
    }
    await backend.shutdown();
    if (!json && checkpoint) process.stdout.write(`adapter ${checkpoint.model}  ${checkpoint.path}\n`);
    return done?.reason === "complete" ? 0 : 1;
}
