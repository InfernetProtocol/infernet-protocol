/**
 * Dependency-free validator for the JSON Schema subset the liquid-agent/v1
 * schemas use: type, const, enum, properties, required, additionalProperties,
 * items, min/maxItems, uniqueItems, min/maxLength, pattern, minimum, maximum,
 * exclusiveMinimum, anyOf, $ref (same file or sibling file) and
 * format: date-time. A keyword outside that list is a schema bug and throws, so
 * the subset cannot silently grow. runtime/infernet_liquid/schema.py mirrors it.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");

const KNOWN = new Set([
    "$schema", "$id", "$defs", "$ref", "title", "description", "type", "const", "enum",
    "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
    "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
    "exclusiveMinimum", "anyOf", "format"
]);

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** kind → schema file. */
export const SCHEMA_FILES = Object.freeze({
    episode: "episode.schema.json",
    dataset_manifest: "dataset-manifest.schema.json",
    dataset_bundle: "dataset-bundle.schema.json",
    train_job: "train-job.schema.json",
    model_manifest: "model-manifest.schema.json",
    inference_session: "inference-session.schema.json",
    predict_request: "predict-request.schema.json",
    action_proposal: "action-proposal.schema.json"
});

let registry = null;

function loadRegistry() {
    if (registry) return registry;
    registry = new Map();
    for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort()) {
        registry.set(file, JSON.parse(readFileSync(path.join(SCHEMA_DIR, file), "utf8")));
    }
    return registry;
}

export function schemaFiles() {
    return [...loadRegistry().keys()];
}

function resolveRef(ref, baseFile) {
    const [file, frag] = ref.split("#");
    const target = file ? file : baseFile;
    const root = loadRegistry().get(target);
    if (!root) throw new Error(`schema $ref to unknown file: ${ref}`);
    let node = root;
    if (frag) {
        for (const part of frag.split("/").filter(Boolean)) {
            node = node?.[part];
            if (node === undefined) throw new Error(`schema $ref not found: ${ref}`);
        }
    }
    return { node, file: target };
}

function typeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
    return typeof v;
}

function typeMatches(want, v) {
    const got = typeOf(v);
    if (want === "number") return got === "number" || got === "integer";
    return want === got;
}

function check(schema, value, at, file, errors) {
    for (const key of Object.keys(schema)) {
        if (!KNOWN.has(key)) throw new Error(`schema keyword not supported by the subset validator: ${key} (${file})`);
    }
    if (schema.$ref) {
        const { node, file: f } = resolveRef(schema.$ref, file);
        check(node, value, at, f, errors);
    }
    if (schema.anyOf) {
        const ok = schema.anyOf.some((s) => {
            const e = [];
            check(s, value, at, file, e);
            return e.length === 0;
        });
        if (!ok) errors.push({ path: at, message: "does not match any allowed shape" });
        return;
    }
    if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
        errors.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
        return;
    }
    if (schema.enum && !schema.enum.some((e) => e === value)) {
        errors.push({ path: at, message: `must be one of ${schema.enum.join(", ")}` });
        return;
    }
    if (schema.type && !typeMatches(schema.type, value)) {
        errors.push({ path: at, message: `must be ${schema.type}` });
        return;
    }
    const t = typeOf(value);
    if (t === "string") {
        if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push({ path: at, message: `shorter than ${schema.minLength}` });
        if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push({ path: at, message: `longer than ${schema.maxLength}` });
        if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errors.push({ path: at, message: `does not match ${schema.pattern}` });
        if (schema.format === "date-time" && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) errors.push({ path: at, message: "not an RFC 3339 date-time" });
    }
    if (t === "number" || t === "integer") {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path: at, message: `below ${schema.minimum}` });
        if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path: at, message: `above ${schema.maximum}` });
        if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push({ path: at, message: `must be > ${schema.exclusiveMinimum}` });
    }
    if (t === "array") {
        if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path: at, message: `fewer than ${schema.minItems} items` });
        if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path: at, message: `more than ${schema.maxItems} items` });
        if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push({ path: at, message: "items must be unique" });
        if (schema.items) value.forEach((v, i) => check(schema.items, v, `${at}/${i}`, file, errors));
    }
    if (t === "object") {
        for (const req of schema.required ?? []) {
            if (!(req in value)) errors.push({ path: `${at}/${req}`, message: "is required" });
        }
        const props = schema.properties ?? {};
        for (const [k, v] of Object.entries(value)) {
            if (k in props) check(props[k], v, `${at}/${k}`, file, errors);
            else if (schema.additionalProperties === false) errors.push({ path: `${at}/${k}`, message: "is not allowed" });
            else if (schema.additionalProperties && typeof schema.additionalProperties === "object") check(schema.additionalProperties, v, `${at}/${k}`, file, errors);
        }
    }
}

/**
 * Validate `value` against a liquid-agent/v1 schema. `kind` defaults to
 * value.kind. Returns { ok, errors: [{path, message}] }.
 */
export function validate(value, kind = value?.kind) {
    const file = SCHEMA_FILES[kind];
    if (!file) return { ok: false, errors: [{ path: "/kind", message: `unknown kind: ${kind}` }] };
    const errors = [];
    check(loadRegistry().get(file), value, "", file, errors);
    return { ok: errors.length === 0, errors };
}

export function assertValid(value, kind) {
    const r = validate(value, kind);
    if (!r.ok) {
        const err = new Error(`${kind ?? value?.kind ?? "object"} failed liquid-agent/v1 validation: ${r.errors.slice(0, 5).map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`);
        err.code = "E_SCHEMA";
        err.errors = r.errors;
        throw err;
    }
    return value;
}
