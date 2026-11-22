/**
 * Where a top-up checkout may send the buyer back to.
 *
 * A trusted client of ours (lib/trusted-clients.js) opens a top-up for one of
 * its own signed-in people and wants CoinPay to return them to its own page,
 * not to our docs. The return URL is handed to CoinPay and followed by the
 * buyer's browser, so it is an open-redirect surface: only an absolute https
 * URL whose origin is on the allowlist is accepted, compared as
 * `new URL(u).origin` exactly (never a prefix or suffix match).
 *
 * `TOPUP_RETURN_ORIGINS`: comma-separated origins. Unset or blank means the
 * default below.
 */

export const DEFAULT_TOPUP_RETURN_ORIGINS = ["https://c0mpute.com"];

const MAX_RETURN_URL_LENGTH = 2000;

/** The allowed origins, normalised. Entries that are not https origins are dropped. */
export function topupReturnOrigins(raw = process.env.TOPUP_RETURN_ORIGINS) {
    const entries = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const out = new Set();
    for (const entry of entries.length > 0 ? entries : DEFAULT_TOPUP_RETURN_ORIGINS) {
        try {
            const u = new URL(entry);
            if (u.protocol === "https:" && !u.username && !u.password) out.add(u.origin);
        } catch {
            /* not a URL: ignored */
        }
    }
    return out;
}

/** True when `value` is an absolute https URL, without credentials, on an allowed origin. */
export function isAllowedReturnUrl(value, origins = topupReturnOrigins()) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_RETURN_URL_LENGTH) return false;
    // new URL() trims and strips tabs/newlines; a value that needs that is not one we pass on.
    if (/[\s\\]/.test(value)) return false;
    let u;
    try {
        u = new URL(value);
    } catch {
        return false;
    }
    if (u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    return origins.has(u.origin);
}

/**
 * Read `success_url` / `cancel_url` from a top-up body.
 * Absent (undefined or null) is fine: the caller falls back to its defaults.
 * Returns { ok: true, successUrl?, cancelUrl? } or { ok: false, field }.
 */
export function parseReturnUrls(body, origins = topupReturnOrigins()) {
    const out = { ok: true };
    for (const [field, key] of [["success_url", "successUrl"], ["cancel_url", "cancelUrl"]]) {
        const value = body?.[field];
        if (value === undefined || value === null) continue;
        if (!isAllowedReturnUrl(value, origins)) return { ok: false, field };
        out[key] = value;
    }
    return out;
}
