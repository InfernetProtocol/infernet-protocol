/**
 * Canonical JSON + content hashes for liquid-agent/v1.
 *
 * Canonical form: object keys sorted, no whitespace, numbers as JSON.stringify
 * prints them, non-finite numbers rejected. The Python runtime
 * (runtime/infernet_liquid/canonical.py) produces byte-identical output; the
 * fixtures pin hashes both sides check.
 */

import { createHash } from "node:crypto";

export function canonicalize(value) {
    if (value === null) return "null";
    switch (typeof value) {
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!Number.isFinite(value)) throw new TypeError("canonical JSON: non-finite number");
            return JSON.stringify(value);
        case "string":
            return JSON.stringify(value);
        case "object": {
            if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
            const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
            return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
        }
        default:
            throw new TypeError(`canonical JSON: unsupported type ${typeof value}`);
    }
}

export function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}

export function hashCanonical(value) {
    return `sha256:${sha256Hex(canonicalize(value))}`;
}

/** Hash of an object with the named self-referencing fields left out. */
export function hashWithout(value, fields) {
    const copy = { ...value };
    for (const f of fields) delete copy[f];
    return hashCanonical(copy);
}

export const episodeHash = (episode) => hashWithout(episode, ["content_hash"]);
export const datasetHash = (manifest) => hashCanonical({ episodes: manifest.episodes, splits: manifest.splits });
export const manifestHash = (manifest) => hashWithout(manifest, ["manifest_hash", "signature"]);
