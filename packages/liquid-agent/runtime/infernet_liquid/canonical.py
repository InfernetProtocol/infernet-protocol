"""Canonical JSON identical to src/canonical.js (sorted keys, no spaces, JS number format)."""

import hashlib
import json
import math


def _num(v):
    if isinstance(v, bool):
        raise TypeError("bool is not a number")
    if isinstance(v, int):
        return str(v)
    if not math.isfinite(v):
        raise TypeError("canonical JSON: non-finite number")
    if v == int(v) and abs(v) < 1e21:
        return str(int(v))
    r = repr(v)
    if "e" in r:
        mant, exp = r.split("e")
        sign = "-" if exp.startswith("-") else "+"
        r = f"{mant}e{sign}{int(exp.lstrip('+-'))}"
    return r


def canonicalize(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _num(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(k for k, v in value.items())
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonicalize(value[k]) for k in keys) + "}"
    raise TypeError(f"canonical JSON: unsupported type {type(value).__name__}")


def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def hash_canonical(value):
    return "sha256:" + sha256_hex(canonicalize(value))


def hash_without(value, fields):
    return hash_canonical({k: v for k, v in value.items() if k not in fields})


def episode_hash(ep):
    return hash_without(ep, ("content_hash",))


def dataset_hash(manifest):
    return hash_canonical({"episodes": manifest["episodes"], "splits": manifest["splits"]})


def manifest_hash(manifest):
    return hash_without(manifest, ("manifest_hash", "signature"))


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()
