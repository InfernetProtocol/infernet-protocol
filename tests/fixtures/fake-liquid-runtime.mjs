// Stands in for `python -m infernet_liquid serve` in tests: same NDJSON contract.
import readline from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify({ v: 1, ...o }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const r = JSON.parse(line);
    if (r.v !== 1) return send({ id: r.id, ok: false, error: { code: "E_BAD_REQUEST", message: "version", retriable: false } });
    switch (r.op) {
        case "health":
            return send({ id: r.id, ok: true, result: { status: "ok" } });
        case "predict":
            return send({ id: r.id, ok: false, error: { code: "E_SEQ_LATE", message: "late", retriable: false, expected: 4 } });
        case "train":
            send({ id: r.id, event: "epoch", epoch: 1, loss: 2.5, val_step_accuracy: 0.4 });
            send({ id: r.id, event: "epoch", epoch: 2, loss: 1.5, val_step_accuracy: 0.8 });
            return send({ id: r.id, ok: true, result: { model_dir: r.output_dir, manifest: { weights: { weights_hash: "sha256:" + "a".repeat(64), size_bytes: 10 }, training: { epochs: 2 } }, eval: { dataset_hash: "sha256:" + "b".repeat(64), metrics: { episode_success: 0.5 } } } });
        case "hang":
            return;
        case "crash":
            process.stderr.write("Traceback: boom\n");
            process.exit(3);
        case "shutdown":
            send({ id: r.id, ok: true, result: { bye: true } });
            return process.exit(0);
        default:
            return send({ id: r.id, ok: false, error: { code: "E_BAD_REQUEST", message: `unknown op ${r.op}`, retriable: false } });
    }
});
