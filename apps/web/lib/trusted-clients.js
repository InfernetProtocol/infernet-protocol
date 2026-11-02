import { createHash } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Trusted clients: our own apps calling the open-market chat API.
 *
 * The public playground limit (20 requests an hour per IP) is right for
 * strangers and wrong for a product of ours that sends all its model calls
 * through c0mpute (OutreachGraph, 2026-11-02, hit it within minutes). A
 * trusted client presents `Authorization: Bearer ifc_...`; the server keeps
 * only SHA-256 hashes of the keys, in `INFERNET_TRUSTED_CLIENT_KEYS`
 * (comma-separated hex, `name:hash` to label one). A trusted key gets its own
 * hourly budget (`INFERNET_TRUSTED_CLIENT_RPH`, default 2000) instead of the
 * per-IP one. It still routes on the open market; nothing else changes.
 *
 * Mint a key: `node -e "const k='ifc_'+require('crypto').randomBytes(24).toString('hex');
 *   console.log(k, require('crypto').createHash('sha256').update(k).digest('hex'))"`
 */

export const TRUSTED_KEY_PREFIX = "ifc_";

export function hashKey(key) {
    return createHash("sha256").update(String(key)).digest("hex");
}

/** `{hash -> name}` from the env list. */
export function trustedKeyHashes(raw = process.env.INFERNET_TRUSTED_CLIENT_KEYS) {
    const map = new Map();
    for (const entry of String(raw ?? "").split(",")) {
        const item = entry.trim();
        if (!item) continue;
        const cut = item.lastIndexOf(":");
        const name = cut > 0 ? item.slice(0, cut) : "trusted";
        const hash = (cut > 0 ? item.slice(cut + 1) : item).toLowerCase();
        if (/^[0-9a-f]{64}$/.test(hash)) map.set(hash, name);
    }
    return map;
}

/** The trusted client a bearer key belongs to, or null. */
export function trustedClientFor(bearer, raw) {
    if (typeof bearer !== "string" || !bearer.startsWith(TRUSTED_KEY_PREFIX)) return null;
    const hash = hashKey(bearer);
    const name = trustedKeyHashes(raw).get(hash);
    return name ? { name, hash } : null;
}

const trustedLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.INFERNET_TRUSTED_CLIENT_RPH) > 0
        ? Number(process.env.INFERNET_TRUSTED_CLIENT_RPH)
        : 2000
});

/**
 * Rate-limit a request: a trusted key against its own budget, anyone else
 * against the playground limiter by IP. Returns the limiter result plus who
 * was counted.
 */
export function checkChatLimit({ bearer, ip, publicLimit }) {
    const trusted = trustedClientFor(bearer);
    if (trusted) return { ...trustedLimit.check(`trusted:${trusted.hash}`), trusted };
    return { ...publicLimit.check(ip), trusted: null };
}

/** `p2p_only` / `p2pOnly`: never hand the job to the hosted (paid) fallback. */
export function wantsP2pOnly(body) {
    const v = body?.p2p_only ?? body?.p2pOnly ?? body?.metadata?.p2p_only;
    return v === true || v === "true";
}
