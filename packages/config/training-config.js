/**
 * Training job config validation, shared by the control plane (which refuses
 * bad jobs at submit) and the CLI/daemon (which refuses to render a training
 * script from a bad config, so a job that slipped in earlier still cannot run).
 *
 * Why it is strict: the Unsloth runner is generated Python source, and values
 * from `training.*` and `lora.*` are written into it. A string where a number
 * belongs is code. In Oct/Nov 2026 jobs arrived with
 * `max_seq_len: "[__import__('os').system(...)...]"` and an `exec('''...''')`
 * that read secrets and posted them out. So every value that reaches a script
 * must be a finite number in range, or a name made of safe characters, and
 * nothing else is accepted.
 */

export const MAX_CONFIG_BYTES = 16 * 1024;

/** Strings that only show up when someone is trying to run code. */
const CODE_MARKERS = [
    /__import__/i,
    /\b(exec|eval|compile|getattr|setattr|globals|locals)\s*\(/i,
    /\bos\s*\.\s*(system|popen|exec\w*|spawn\w*|environ)/i,
    /\bsubprocess\b/i,
    /\bimportlib\b/i,
    /\bbuiltins\b/i,
    /\$\(|`/,
    /'''|"""/,
    /\\x[0-9a-f]{2}|\\u00[0-9a-f]{2}/i,
    /\bcurl\s+-|\bwget\s+http|\/bin\/(ba)?sh\b/i
];

const INT = "int";
const NUM = "num";

/** Fields that are written into generated training scripts. */
const NUMERIC_FIELDS = {
    training: {
        epochs: [INT, 1, 1000],
        learning_rate: [NUM, 1e-12, 1],
        batch_size: [INT, 1, 4096],
        gradient_accumulation_steps: [INT, 1, 4096],
        max_seq_len: [INT, 16, 1048576],
        seed: [INT, 0, 4294967295],
        warmup_steps: [INT, 0, 10000000],
        max_steps: [INT, -1, 100000000],
        weight_decay: [NUM, 0, 10]
    },
    lora: {
        rank: [INT, 1, 4096],
        alpha: [NUM, 0, 65536],
        dropout: [NUM, 0, 1]
    }
};

/** Sections that are metadata only: short scalars, never rendered into code. */
const METADATA_SECTIONS = new Set(["input", "resources", "outputs"]);
const SCALAR_TOP_LEVEL = new Set(["name", "method", "runtime", "workload_class", "base_model"]);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/:@+]{0,199}$/;
const MODULE_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
const NUMERIC_STRING_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

export class TrainingConfigError extends Error {
    /**
     * @param {string} message
     * @param {{ field?: string, attack?: boolean }} [opts]
     *   attack: the value carried code, so this is an attack, not a typo.
     */
    constructor(message, { field = null, attack = false } = {}) {
        super(message);
        this.name = "TrainingConfigError";
        this.status = 400;
        this.field = field;
        this.attack = attack;
    }
}

/** True when a string looks like an attempt to run code. */
export function looksLikeCode(value) {
    return typeof value === "string" && CODE_MARKERS.some((re) => re.test(value));
}

function fail(field, message, value) {
    throw new TrainingConfigError(`${field}: ${message}`, { field, attack: looksLikeCode(value) });
}

function toNumber(field, value, [kind, min, max]) {
    let n = value;
    if (typeof n === "string") {
        if (!NUMERIC_STRING_RE.test(n.trim())) fail(field, "must be a number", value);
        n = Number(n.trim());
    }
    if (typeof n !== "number" || !Number.isFinite(n)) fail(field, "must be a number", value);
    if (kind === INT && !Number.isInteger(n)) fail(field, "must be an integer", value);
    if (n < min || n > max) fail(field, `must be between ${min} and ${max}`, value);
    return n;
}

function checkScalar(field, value) {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) fail(field, "must be finite", value);
        return value;
    }
    if (typeof value === "string") {
        if (value.length > 256) fail(field, "is too long (max 256)", value);
        if (looksLikeCode(value)) fail(field, "contains code", value);
        return value;
    }
    fail(field, "must be a string, number, boolean or null", value);
}

/** A model id: HF repo, Ollama tag or local name. */
export function validateModelName(value, field = "base_model") {
    if (typeof value !== "string" || !NAME_RE.test(value)) {
        fail(field, "must be a model name (letters, digits and . _ - / : @ +, max 200)", value);
    }
    return value;
}

/**
 * Validate and normalise a training config.
 * Returns a new object: numbers are real numbers, unknown keys are refused.
 * Throws TrainingConfigError (status 400; `attack` true when it carried code).
 *
 * @param {unknown} config
 * @returns {Record<string, unknown>}
 */
export function validateTrainingConfig(config) {
    if (config === undefined || config === null) return {};
    if (typeof config !== "object" || Array.isArray(config)) {
        fail("config", "must be an object", typeof config === "string" ? config : "");
    }
    let size;
    try {
        size = JSON.stringify(config).length;
    } catch {
        fail("config", "must be plain JSON", "");
    }
    if (size > MAX_CONFIG_BYTES) fail("config", `is too large (max ${MAX_CONFIG_BYTES} bytes)`, "");

    const out = {};
    for (const [key, value] of Object.entries(config)) {
        if (key in NUMERIC_FIELDS) {
            if (value === undefined || value === null) continue;
            if (typeof value !== "object" || Array.isArray(value)) fail(key, "must be an object", value);
            const section = {};
            for (const [k, v] of Object.entries(value)) {
                const field = `${key}.${k}`;
                if (v === undefined || v === null) continue;
                if (key === "lora" && k === "target_modules") {
                    if (!Array.isArray(v) || v.length > 64) fail(field, "must be a list of up to 64 module names", v);
                    section[k] = v.map((m, i) => {
                        if (typeof m !== "string" || !MODULE_RE.test(m)) fail(`${field}[${i}]`, "must be a module name", m);
                        return m;
                    });
                    continue;
                }
                const spec = NUMERIC_FIELDS[key][k];
                if (!spec) fail(field, "is not a known setting", typeof v === "string" ? v : "");
                section[k] = toNumber(field, v, spec);
            }
            out[key] = section;
        } else if (METADATA_SECTIONS.has(key)) {
            if (value === undefined || value === null) continue;
            if (typeof value !== "object" || Array.isArray(value)) fail(key, "must be an object", value);
            const section = {};
            for (const [k, v] of Object.entries(value)) {
                const field = `${key}.${k}`;
                section[k] = Array.isArray(v)
                    ? (v.length > 64 ? fail(field, "is too long", "") : v.map((x, i) => checkScalar(`${field}[${i}]`, x)))
                    : checkScalar(field, v);
            }
            out[key] = section;
        } else if (key === "base_model") {
            out[key] = validateModelName(value);
        } else if (SCALAR_TOP_LEVEL.has(key)) {
            out[key] = checkScalar(key, value);
        } else {
            fail(key, "is not a known setting", typeof value === "string" ? value : "");
        }
    }
    return out;
}

const PRIVATE_V4 = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0a80000, 16],
    [0xc6120000, 15], [0xe0000000, 3]
];

function ipv4ToInt(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isPrivateHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
    const v4 = ipv4ToInt(host);
    if (v4 !== null) return PRIVATE_V4.some(([base, bits]) => (v4 >>> (32 - bits)) === (base >>> (32 - bits)));
    if (host.includes(":")) {
        return host === "::" || host === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith("::ffff:");
    }
    return false;
}

/**
 * A dataset or upload URL operators will fetch: http(s) to a public host, so a
 * job cannot point workers at their own localhost, cloud metadata or private
 * network. Plain http stays allowed because the documented flow serves shards
 * from the submitter's daemon (`http://<public-ip>:8080`).
 */
export function validateTrainingUrl(value, field) {
    let url;
    try {
        url = new URL(String(value));
    } catch {
        fail(field, "must be a URL", String(value ?? ""));
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") fail(field, "must be an http(s) URL", String(value));
    if (url.username || url.password) fail(field, "must not carry credentials", String(value));
    if (isPrivateHost(url.hostname)) fail(field, "must be a public host", String(value));
    if (String(value).length > 2048) fail(field, "is too long", "");
    return url.toString();
}
