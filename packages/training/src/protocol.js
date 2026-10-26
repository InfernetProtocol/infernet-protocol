/**
 * Training IPC protocol — v1.
 *
 * Mirrors @infernetprotocol/engine/protocol but for training jobs. NDJSON
 * over stdio between the JS sidecar and a Python training runner (DeepSpeed
 * launcher, OpenDiLoCo worker, Petals client, etc.).
 *
 * Outbound (JS → trainer):
 *   { v:1, type:"start",    id, config }
 *   { v:1, type:"cancel",   id }
 *   { v:1, type:"shutdown" }
 *
 * Inbound (trainer → JS):
 *   { v:1, type:"meta",       id, started_at, world_size?, backend }
 *   { v:1, type:"step",       id, step, loss, lr?, throughput?, grad_norm? }
 *   { v:1, type:"checkpoint", id, step, path, size_bytes? }
 *   { v:1, type:"eval",       id, step, metrics }
 *   { v:1, type:"done",       id, reason:"complete"|"cancel"|"error"|"not_implemented", final_step?, finished_at }
 *   { v:1, type:"error",      id?, message }
 *   { v:1, type:"log",        level:"info"|"warn"|"error", message }
 *
 * Job config shape (extend as needed; backends ignore fields they don't use):
 *   {
 *     kind: "fine-tune" | "lora" | "rlhf-rollout" | "pretrain" | "temporal-policy",
 *     base_model: string,
 *     dataset: { url, sha256?, format?, split? },
 *     hyperparams: { lr?, batch_size?, epochs?, max_steps? },
 *     output: { destination_url, format? }
 *   }
 *
 * Bumping TRAINING_PROTOCOL_VERSION is a breaking change.
 */

export const TRAINING_PROTOCOL_VERSION = 1;

export const TMSG = Object.freeze({
    // outbound
    START: "start",
    CANCEL: "cancel",
    SHUTDOWN: "shutdown",
    // inbound
    META: "meta",
    STEP: "step",
    CHECKPOINT: "checkpoint",
    EVAL: "eval",
    DONE: "done",
    ERROR: "error",
    LOG: "log"
});

export const JOB_KINDS = Object.freeze(["fine-tune", "lora", "rlhf-rollout", "pretrain", "temporal-policy"]);

export const DONE_REASONS = Object.freeze(["complete", "cancel", "error", "not_implemented"]);

export function encodeTraining(msg) {
    return JSON.stringify({ v: TRAINING_PROTOCOL_VERSION, ...msg }) + "\n";
}
