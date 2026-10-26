"""Subset JSON Schema validator mirroring src/validate.js over the same schema files."""

import json
import re
from datetime import datetime
from pathlib import Path

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schemas"

SCHEMA_FILES = {
    "episode": "episode.schema.json",
    "dataset_manifest": "dataset-manifest.schema.json",
    "dataset_bundle": "dataset-bundle.schema.json",
    "train_job": "train-job.schema.json",
    "model_manifest": "model-manifest.schema.json",
    "inference_session": "inference-session.schema.json",
    "predict_request": "predict-request.schema.json",
    "action_proposal": "action-proposal.schema.json",
}

KNOWN = {
    "$schema", "$id", "$defs", "$ref", "title", "description", "type", "const", "enum",
    "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
    "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
    "exclusiveMinimum", "anyOf", "format",
}

DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")

_registry = None


def _load():
    global _registry
    if _registry is None:
        _registry = {p.name: json.loads(p.read_text("utf-8")) for p in sorted(SCHEMA_DIR.glob("*.schema.json"))}
    return _registry


def _resolve(ref, base):
    file, _, frag = ref.partition("#")
    target = file or base
    node = _load().get(target)
    if node is None:
        raise ValueError(f"schema $ref to unknown file: {ref}")
    for part in [p for p in frag.split("/") if p]:
        node = node[part]
    return node, target


def _type_of(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "integer" if v == int(v) else "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def _type_ok(want, v):
    got = _type_of(v)
    return got in ("number", "integer") if want == "number" else want == got


def _check(schema, value, at, file, errors):
    unknown = set(schema) - KNOWN
    if unknown:
        raise ValueError(f"schema keyword not supported by the subset validator: {sorted(unknown)} ({file})")
    if "$ref" in schema:
        node, f = _resolve(schema["$ref"], file)
        _check(node, value, at, f, errors)
    if "anyOf" in schema:
        for s in schema["anyOf"]:
            e = []
            _check(s, value, at, file, e)
            if not e:
                return
        errors.append((at, "does not match any allowed shape"))
        return
    if "const" in schema and json.dumps(schema["const"]) != json.dumps(value):
        errors.append((at, f"must equal {json.dumps(schema['const'])}"))
        return
    if "enum" in schema and not any(value == e and _type_of(value) == _type_of(e) for e in schema["enum"]):
        errors.append((at, "must be one of " + ", ".join(map(str, schema["enum"]))))
        return
    if "type" in schema and not _type_ok(schema["type"], value):
        errors.append((at, f"must be {schema['type']}"))
        return
    t = _type_of(value)
    if t == "string":
        n = len(value)
        if "minLength" in schema and n < schema["minLength"]:
            errors.append((at, f"shorter than {schema['minLength']}"))
        if "maxLength" in schema and n > schema["maxLength"]:
            errors.append((at, f"longer than {schema['maxLength']}"))
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append((at, f"does not match {schema['pattern']}"))
        if schema.get("format") == "date-time":
            ok = bool(DATE_TIME.match(value))
            if ok:
                try:
                    datetime.fromisoformat(value.replace("Z", "+00:00"))
                except ValueError:
                    ok = False
            if not ok:
                errors.append((at, "not an RFC 3339 date-time"))
    if t in ("number", "integer"):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append((at, f"below {schema['minimum']}"))
        if "maximum" in schema and value > schema["maximum"]:
            errors.append((at, f"above {schema['maximum']}"))
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            errors.append((at, f"must be > {schema['exclusiveMinimum']}"))
    if t == "array":
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append((at, f"fewer than {schema['minItems']} items"))
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append((at, f"more than {schema['maxItems']} items"))
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            errors.append((at, "items must be unique"))
        if "items" in schema:
            for i, v in enumerate(value):
                _check(schema["items"], v, f"{at}/{i}", file, errors)
    if t == "object":
        for req in schema.get("required", []):
            if req not in value:
                errors.append((f"{at}/{req}", "is required"))
        props = schema.get("properties", {})
        addl = schema.get("additionalProperties")
        for k, v in value.items():
            if k in props:
                _check(props[k], v, f"{at}/{k}", file, errors)
            elif addl is False:
                errors.append((f"{at}/{k}", "is not allowed"))
            elif isinstance(addl, dict):
                _check(addl, v, f"{at}/{k}", file, errors)


def validate(value, kind=None):
    kind = kind or (value.get("kind") if isinstance(value, dict) else None)
    file = SCHEMA_FILES.get(kind)
    if not file:
        return [("/kind", f"unknown kind: {kind}")]
    errors = []
    _check(_load()[file], value, "", file, errors)
    return errors
