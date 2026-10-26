/**
 * @infernetprotocol/training — pluggable training orchestration.
 *
 *   const trainer = await createTrainer();        // auto-selects
 *   const { stream } = trainer.start({ config });
 *   for await (const ev of stream) {
 *     // ev.type ∈ "meta" | "step" | "checkpoint" | "eval" | "done" | "error"
 *   }
 *   await trainer.shutdown();
 *
 * Backends (each is a placeholder until the underlying runtime is wired in):
 *   - "deepspeed"  — trusted-cluster sharded training (DeepSpeed/torchrun).
 *                    Class B: one provider's hardware.
 *   - "openrlhf"   — RLHF with vLLM rollouts + DeepSpeed updates.
 *                    Class B-RLHF: trusted cluster, leverages our vLLM engine.
 *   - "opendiloco" — cross-provider async training (Prime Intellect's
 *                    OpenDiLoCo). Class C: WAN-tolerant delta exchange.
 *   - "petals"     — pipeline-parallel sharding for fine-tunes across
 *                    volunteer GPUs. Class C-LLM: BigScience's Petals.
 *   - "liquid"     — temporal policies (CfC/LTC liquid networks, GRU
 *                    baseline) via the isolated infernet-liquid runtime.
 *                    Single provider, CPU or GPU. Workload
 *                    infernet.temporal.train.
 *   - "stub"       — synthetic training run, no GPU required. Default.
 *
 * Auto-selection precedence (only if `opts.backend` is not set):
 *   1. process.env.INFERNET_TRAINING_BACKEND — explicit
 *   2. "stub" — until real runtime detection lands
 */

import { createDeepspeedBackend } from "./backends/deepspeed.js";
import { createLiquidBackend } from "./backends/liquid.js";
import { createOpenDiLoCoBackend } from "./backends/opendiloco.js";
import { createOpenRLHFBackend } from "./backends/openrlhf.js";
import { createPetalsBackend } from "./backends/petals.js";
import { createStubTrainer } from "./backends/stub.js";

export * from "./protocol.js";

export async function createTrainer(opts = {}) {
    const backend = opts.backend ?? autoSelectBackend();
    switch (backend) {
        case "deepspeed":
            return createDeepspeedBackend(opts);
        case "openrlhf":
            return createOpenRLHFBackend(opts);
        case "opendiloco":
            return createOpenDiLoCoBackend(opts);
        case "petals":
            return createPetalsBackend(opts);
        case "liquid":
            return createLiquidBackend(opts);
        case "stub":
            return createStubTrainer(opts);
        default:
            throw new Error(`unknown training backend: ${backend}`);
    }
}

function autoSelectBackend() {
    const explicit = process.env.INFERNET_TRAINING_BACKEND;
    if (explicit) return explicit;
    return "stub";
}
