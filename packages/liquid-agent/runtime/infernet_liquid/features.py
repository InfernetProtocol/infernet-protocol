"""hashed-bag/v1 featurisation of steps and of the visible UI elements.

Steps become a fixed-width vector from hashed tokens (task, app, url pattern,
focus, visible element words, previous action) plus log1p(seconds since the last
step). Elements become their own hashed vectors so the policy can *point* at a
visible element instead of choosing from a fixed name vocabulary; that is what
lets a model trained on "From Dana: Lunch?" click "From Sam: Invoice" later.
"""

import hashlib
import math
import re

ACTION_TYPES = [
    "click", "double_click", "type", "key", "scroll", "navigate", "select", "focus",
    "wait", "submit", "send", "post", "publish", "delete", "done",
]
EXTERNAL_WRITE = {"submit", "send", "post", "publish", "delete"}
TARGETED = {"click", "double_click", "type", "select", "focus", "submit", "send", "post", "publish", "delete"}

ELEMENT_DIM = 128
MAX_ELEMENTS = 64
WORD = re.compile(r"[a-z0-9]+")


def norm(s):
    return " ".join(str(s or "").lower().split())[:80]


def element_key(el):
    if not el:
        return ""
    return f"{norm(el.get('role'))}:{norm(el.get('name'))}"


def _bucket(token, dim):
    d = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    n = int.from_bytes(d, "little")
    return n % dim, (1.0 if (n >> 63) & 1 else -1.0)


def _add(vec, token, weight, dim):
    i, s = _bucket(token, dim)
    vec[i] += s * weight


def words(s):
    return WORD.findall(norm(s))


def encode_step(task, observation, prev_action, dt_ms, feature_dim):
    """Return a list[float] of length feature_dim. The last two slots are log1p(dt seconds) and a bias."""
    dim = feature_dim - 2
    v = [0.0] * feature_dim
    obs = observation or {}
    if task:
        _add(v, f"task:{task}", 1.0, dim)
    _add(v, f"app:{norm(obs.get('app'))}", 1.0, dim)
    if obs.get("url_pattern"):
        _add(v, f"url:{norm(obs['url_pattern'])}", 1.0, dim)
    _add(v, f"loading:{bool(obs.get('loading'))}", 1.0, dim)
    if obs.get("focus"):
        _add(v, f"focus:{element_key(obs['focus'])}", 1.0, dim)
        _add(v, f"focusrole:{norm(obs['focus'].get('role'))}", 1.0, dim)
    els = (obs.get("elements") or [])[:MAX_ELEMENTS]
    if els:
        w = 1.0 / math.sqrt(len(els))
        for el in els:
            _add(v, f"elrole:{norm(el.get('role'))}", w, dim)
            for word in words(el.get("name")):
                _add(v, f"elword:{word}", w, dim)
    if prev_action:
        _add(v, f"pa:{prev_action.get('type')}", 1.0, dim)
        if prev_action.get("target"):
            _add(v, f"pt:{element_key(prev_action['target'])}", 0.5, dim)
            _add(v, f"ptrole:{norm(prev_action['target'].get('role'))}", 1.0, dim)
    else:
        _add(v, "pa:<start>", 1.0, dim)
    v[feature_dim - 2] = math.log1p(max(0, dt_ms or 0) / 1000.0)
    v[feature_dim - 1] = 1.0
    return v


def encode_element(el, index):
    v = [0.0] * ELEMENT_DIM
    dim = ELEMENT_DIM - 1
    _add(v, f"role:{norm(el.get('role'))}", 1.0, dim)
    ws = words(el.get("name"))
    for w in ws:
        _add(v, f"word:{w}", 1.0 / math.sqrt(len(ws)), dim)
        _add(v, f"rw:{norm(el.get('role'))}:{w}", 0.5 / math.sqrt(len(ws)), dim)
    _add(v, f"pos:{min(index, 8)}", 0.5, dim)
    v[ELEMENT_DIM - 1] = 1.0
    return v


def target_index(observation, action):
    """Index of the action's target among the visible elements, -1 for no target, None if not visible."""
    if not action or not action.get("target"):
        return -1
    key = element_key(action["target"])
    for i, el in enumerate(((observation or {}).get("elements") or [])[:MAX_ELEMENTS]):
        if element_key(el) == key:
            return i
    return None
