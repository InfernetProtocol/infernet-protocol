/**
 * Secret scan for anything that may leave the device or reach a log.
 * Episodes must never carry credentials, cookies, tokens or card numbers;
 * redaction happens at capture, this is the second fence before export,
 * upload or training. Mirrored in runtime/infernet_liquid/secrets.py.
 */

export const SCANNER_VERSION = "1";

const PATTERNS = [
    ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
    ["aws_access_key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
    ["github_token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
    ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
    ["api_key", /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{20,}\b/],
    ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
    ["cookie", /\b(set-cookie|cookie)\s*:/i],
    ["password_assignment", /\b(pass(word)?|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{4,}/i]
];

// Structural fields are hashes/ids/timestamps; long digit runs there are not cards.
const STRUCTURAL = /(_hash|_ref|_id|_at|_ms|^seed$|^dt_ms$|^t_ms$)$/;

function luhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
        let d = digits.charCodeAt(i) - 48;
        if (alt) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
        alt = !alt;
    }
    return sum % 10 === 0;
}

export function scanText(text) {
    const hits = [];
    for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(name);
    for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
        const digits = m[0].replace(/[ -]/g, "");
        if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
            hits.push("card_number");
            break;
        }
    }
    return hits;
}

/** Walk any JSON value; returns [{path, kinds}] for every string that looks secret. */
export function scanSecrets(value, at = "") {
    const out = [];
    const walk = (v, p, key) => {
        if (typeof v === "string") {
            if (key && STRUCTURAL.test(key)) return;
            const kinds = scanText(v);
            if (kinds.length) out.push({ path: p, kinds });
        } else if (Array.isArray(v)) {
            v.forEach((x, i) => walk(x, `${p}/${i}`, key));
        } else if (v && typeof v === "object") {
            for (const [k, x] of Object.entries(v)) walk(x, `${p}/${k}`, k);
        }
    };
    walk(value, at, null);
    return out;
}

export function assertNoSecrets(value, label = "payload") {
    const hits = scanSecrets(value);
    if (hits.length) {
        const err = new Error(`${label} contains what looks like a secret at ${hits.slice(0, 3).map((h) => `${h.path} (${h.kinds.join(",")})`).join("; ")}; redact it before export`);
        err.code = "E_SECRET_DETECTED";
        err.hits = hits;
        throw err;
    }
}
