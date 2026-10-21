import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Coarse node location for /nodes/[id] and /status: country, region, city and
 * network (ASN owner), from a keyless IP lookup. Looked up only when a node's
 * IP changes (cached in `geo` / `geo_ip`), so ~one call per node per move.
 * The raw IP is never shown.
 */

const LOOKUP_TIMEOUT_MS = 4_000;
const inFlight = new Set();

export function isPublicIp(ip) {
    if (typeof ip !== "string" || ip.length === 0 || ip.length > 45) return false;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 169 && b === 254) return false;
        if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
        return true;
    }
    if (!ip.includes(":")) return false;
    const lower = ip.toLowerCase();
    return !(lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80"));
}

async function getJson(url) {
    const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "infernetprotocol.com" },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        cache: "no-store"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/** @returns {Promise<{country, country_code, region, city, network}|null>} */
export async function lookupGeo(ip) {
    if (!isPublicIp(ip)) return null;
    try {
        const d = await getJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
        if (d?.success !== false && d?.country) {
            return {
                country: d.country ?? null,
                country_code: d.country_code ?? null,
                region: d.region ?? null,
                city: d.city ?? null,
                network: d.connection?.org ?? d.connection?.isp ?? null
            };
        }
    } catch { /* try the next source */ }
    try {
        const d = await getJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
        if (!d?.error && d?.country_name) {
            return {
                country: d.country_name ?? null,
                country_code: d.country_code ?? null,
                region: d.region ?? null,
                city: d.city ?? null,
                network: d.org ?? null
            };
        }
    } catch { /* give up until the next heartbeat */ }
    return null;
}

/**
 * Refresh a node row's geo when its IP changed. Fire-and-forget from the
 * heartbeat path: never throws, never blocks the response.
 */
export function refreshGeoIfMoved({ table, id, ip, knownIp }) {
    if (!isPublicIp(ip) || ip === knownIp || inFlight.has(id)) return;
    inFlight.add(id);
    (async () => {
        try {
            const geo = await lookupGeo(ip);
            if (!geo) return;
            await getSupabaseServerClient().from(table).update({ geo, geo_ip: ip }).eq("id", id);
        } catch { /* next heartbeat retries */ } finally {
            inFlight.delete(id);
        }
    })();
}

/** "Helsinki, Uusimaa, Finland · Hetzner" style one-liner. */
export function formatGeo(geo) {
    if (!geo || typeof geo !== "object") return null;
    const place = [geo.city, geo.region, geo.country].filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i).join(", ");
    return [place, geo.network].filter(Boolean).join(" · ") || null;
}
