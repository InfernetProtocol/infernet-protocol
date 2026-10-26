/**
 * Liquid backend — temporal-policy training (CfC / LTC liquid networks, GRU
 * baseline) on one provider, CPU or GPU. Workload `infernet.temporal.train`.
 *
 * Runs the isolated infernet-liquid runtime from @infernetprotocol/liquid-agent
 * and maps its events onto this package's v1 training protocol:
 *   epoch  → step  (step = epoch, loss, val_step_accuracy)
 *   result → eval + checkpoint (the exported model dir) + done:complete
 *   error  → error + done:error (done:cancel for E_CANCELLED)
 *
 * Job config:
 *   { kind: "temporal-policy", dataset: { url: <bundle path>, sha256? },
 *     output: { destination_url: <dir> }, family?: "cfc"|"ltc"|"gru",
 *     hyperparams?: {...}, job?: TrainJobV1 }
 */

import { randomUUID } from "node:crypto";
import { AsyncQueue } from "@infernetprotocol/engine";
import { LiquidRuntime } from "@infernetprotocol/liquid-agent";
import { TMSG, TRAINING_PROTOCOL_VERSION } from "../protocol.js";

export function createLiquidBackend({ runtimeFactory = () => new LiquidRuntime() } = {}) {
    let runtime = null;
    return {
        kind: "liquid",
        start({ config = {}, id } = {}) {
            const jobId = id ?? randomUUID();
            const stream = new AsyncQueue();
            const push = (msg) => stream.push({ v: TRAINING_PROTOCOL_VERSION, id: jobId, ...msg });
            let cancelled = false;
            let reqId = null;

            (async () => {
                const family = config.job?.model_type ?? config.family ?? "cfc";
                push({ type: TMSG.META, backend: "liquid", started_at: new Date().toISOString(), world_size: 1, kind: "temporal-policy", family });
                try {
                    runtime ??= runtimeFactory();
                    const params = {
                        bundle_path: config.dataset?.url,
                        output_dir: config.output?.destination_url,
                        family,
                        hyperparameters: config.hyperparams ?? {},
                        ...(config.job ? { job: config.job } : {})
                    };
                    if (cancelled) throw Object.assign(new Error("cancelled"), { code: "E_CANCELLED" });
                    const res = await runtime.request("train", params, {
                        onId: (rid) => {
                            reqId = rid;
                        },
                        onEvent: (ev) => {
                            if (ev.event === "epoch") push({ type: TMSG.STEP, step: ev.epoch, loss: ev.loss, val_step_accuracy: ev.val_step_accuracy });
                        }
                    });
                    if (config.dataset?.sha256 && res.eval.dataset_hash !== config.dataset.sha256) {
                        throw Object.assign(new Error("trained dataset hash differs from the job's"), { code: "E_HASH_MISMATCH" });
                    }
                    push({ type: TMSG.EVAL, step: res.manifest.training.epochs, metrics: res.eval.metrics });
                    push({ type: TMSG.CHECKPOINT, step: res.manifest.training.epochs, path: res.model_dir, size_bytes: res.manifest.weights.size_bytes, model_hash: res.manifest.weights.weights_hash });
                    push({ type: TMSG.DONE, reason: "complete", final_step: res.manifest.training.epochs, finished_at: new Date().toISOString(), manifest: res.manifest });
                } catch (err) {
                    const reason = cancelled || err?.code === "E_CANCELLED" ? "cancel" : "error";
                    if (reason === "error") push({ type: TMSG.ERROR, message: err?.message ?? String(err), code: err?.code ?? "E_RUNTIME" });
                    push({ type: TMSG.DONE, reason, finished_at: new Date().toISOString() });
                }
                stream.end();
            })();

            return {
                id: jobId,
                stream,
                cancel: () => {
                    cancelled = true;
                    if (reqId) runtime?.cancel(reqId).catch(() => {});
                }
            };
        },
        async shutdown() {
            await runtime?.close();
            runtime = null;
        }
    };
}
