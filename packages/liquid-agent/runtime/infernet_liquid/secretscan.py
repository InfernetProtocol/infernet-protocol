"""Secret scan mirroring src/secrets.js; a second fence after redaction at capture."""

import re

SCANNER_VERSION = "1"

PATTERNS = [
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("aws_access_key", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("api_key", re.compile(r"\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{20,}\b")),
    ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{16,}", re.I)),
    ("cookie", re.compile(r"\b(set-cookie|cookie)\s*:", re.I)),
    ("password_assignment", re.compile(r"\b(pass(word)?|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{4,}", re.I)),
]

STRUCTURAL = re.compile(r"(_hash|_ref|_id|_at|_ms|^seed$|^dt_ms$|^t_ms$)$")
CARDISH = re.compile(r"(?:\d[ -]?){13,19}")


def _luhn(digits):
    total, alt = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def scan_text(text):
    hits = [name for name, rx in PATTERNS if rx.search(text)]
    for m in CARDISH.finditer(text):
        digits = re.sub(r"[ -]", "", m.group(0))
        if 13 <= len(digits) <= 19 and _luhn(digits):
            hits.append("card_number")
            break
    return hits


def scan_secrets(value):
    out = []

    def walk(v, path, key):
        if isinstance(v, str):
            if key and STRUCTURAL.search(key):
                return
            kinds = scan_text(v)
            if kinds:
                out.append({"path": path, "kinds": kinds})
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, f"{path}/{i}", key)
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, f"{path}/{k}", k)

    walk(value, "", None)
    return out
