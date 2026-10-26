/**
 * liquid-agent/v1 constants shared by the CLI, the training backend, c0mpute
 * and W3BS. Workload ids follow c0mpute's `<plugin>.<family>.<op>` naming.
 */

export const SCHEMA_VERSION = "liquid-agent/v1";

/** Runtime protocol spoken over the infernet-liquid subprocess's stdio. */
export const RUNTIME_PROTOCOL_VERSION = 1;

export const WORKLOADS = Object.freeze({
    TRAIN: "infernet.temporal.train",
    INFER: "infernet.temporal.infer"
});

export const MODEL_FAMILY = "temporal-policy";
export const FAMILIES = Object.freeze(["cfc", "ltc", "gru"]);
/** LTC is slow to train (ODE unfolds) and kept for research comparisons. */
export const RESEARCH_FAMILIES = Object.freeze(["ltc"]);

export const ACTION_TYPES = Object.freeze([
    "click", "double_click", "type", "key", "scroll", "navigate", "select", "focus",
    "wait", "submit", "send", "post", "publish", "delete", "done"
]);

/**
 * Actions with an effect outside the local UI: posting, sending, deleting,
 * submitting a form. These always need a person's approval at action time
 * unless a narrower, separately authorised rule says otherwise.
 */
export const EXTERNAL_WRITE_ACTIONS = Object.freeze(["submit", "send", "post", "publish", "delete"]);

/** Ops of the runtime contract, mapped to the PRD adapter names. */
export const RUNTIME_OPS = Object.freeze([
    "health", "capabilities", "validate", "train", "evaluate", "load", "unload",
    "open_session", "predict", "reset", "close_session", "checkpoint", "restore", "shutdown"
]);

/** Failure taxonomy. `retriable` tells a dispatcher whether another try can help. */
export const ERROR_CODES = Object.freeze({
    E_BAD_REQUEST: { retriable: false },
    E_SCHEMA: { retriable: false },
    E_HASH_MISMATCH: { retriable: false },
    E_SECRET_DETECTED: { retriable: false },
    E_CONSENT: { retriable: false },
    E_MODEL_HASH: { retriable: false },
    E_NOT_LOADED: { retriable: false },
    E_SESSION_UNKNOWN: { retriable: false },
    E_SESSION_EXPIRED: { retriable: false },
    E_SEQ_DUPLICATE: { retriable: false },
    E_SEQ_LATE: { retriable: false },
    E_SEQ_GAP: { retriable: false },
    E_CAPACITY: { retriable: true },
    E_TIMEOUT: { retriable: true },
    E_CANCELLED: { retriable: false },
    E_RUNTIME_MISSING: { retriable: false },
    E_RUNTIME: { retriable: true }
});

export function isExternalWrite(action) {
    return !!action && EXTERNAL_WRITE_ACTIONS.includes(action.type);
}
