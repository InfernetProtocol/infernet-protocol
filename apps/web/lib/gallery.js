// What people have built on c0mpute / the Infernet network. The list lives on
// c0mpute.com (GET /api/v1/gallery) so both galleries show the same entries; this
// module reads it server-side.
//
// The root layout is force-dynamic, which turns Next's fetch cache off, so the
// list is cached here in module scope for 10 minutes. A stale copy is served at
// once while a refresh runs in the background, so a slow c0mpute.com never holds
// up the page. With nothing cached and c0mpute.com down, the bundled copy in
// gallery-fallback.json (same shape) is shown.
import fallback from "./gallery-fallback.json" with { type: "json" };

export const GALLERY_URL =
    process.env.C0MPUTE_GALLERY_URL || "https://c0mpute.com/api/v1/gallery";
export const GALLERY_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

function safeUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
        const u = new URL(value);
        return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch {
        return null;
    }
}

function text(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function slugify(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/** One entry as the page renders it, or null when it has no name or link. */
export function normalizeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = text(raw.name, 120);
    const url = safeUrl(raw.url);
    if (!name || !url) return null;
    const builtWith = Array.isArray(raw.built_with)
        ? raw.built_with.map((b) => text(b, 60)).filter(Boolean).slice(0, 8)
        : [];
    const added = typeof raw.added_at === "string" && !Number.isNaN(Date.parse(raw.added_at))
        ? raw.added_at
        : null;
    return {
        slug: text(raw.slug, 120) || slugify(name),
        name,
        tagline: text(raw.tagline, 400),
        url,
        c0mpute_url: safeUrl(raw.c0mpute_url),
        category: text(raw.category, 40) || "Other",
        built_with: builtWith,
        image: safeUrl(raw.image),
        added_at: added
    };
}

/** Accepts a bare array or { entries | items | data | gallery: [...] }. */
export function normalizeGallery(body) {
    const list = Array.isArray(body)
        ? body
        : body && typeof body === "object"
          ? body.entries ?? body.items ?? body.data ?? body.gallery
          : null;
    if (!Array.isArray(list)) return null;
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const entry = normalizeEntry(raw);
        if (!entry || seen.has(entry.slug)) continue;
        seen.add(entry.slug);
        out.push(entry);
    }
    // Newest first; undated entries last, in the order they came.
    return out
        .map((e, i) => ({ e, i }))
        .sort((a, b) => {
            const ta = a.e.added_at ? Date.parse(a.e.added_at) : -Infinity;
            const tb = b.e.added_at ? Date.parse(b.e.added_at) : -Infinity;
            return tb === ta ? a.i - b.i : tb - ta;
        })
        .map(({ e }) => e);
}

export function fallbackGallery() {
    return normalizeGallery(fallback) ?? [];
}

export async function fetchGallery({ fetchImpl = fetch, url = GALLERY_URL } = {}) {
    const res = await fetchImpl(url, {
        cache: "no-store",
        headers: { accept: "application/json", "user-agent": "infernetprotocol.com gallery" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`gallery ${res.status}`);
    const entries = normalizeGallery(await res.json());
    if (!entries) throw new Error("gallery: unexpected body");
    return entries;
}

const cache = { entries: null, source: null, fetchedAt: 0, inflight: null };

function refresh(opts) {
    if (!cache.inflight) {
        cache.inflight = fetchGallery(opts)
            .then((entries) => {
                // An empty live list would blank the page; keep the last good one.
                if (entries.length || !cache.entries) {
                    cache.entries = entries;
                    cache.source = "c0mpute";
                }
            })
            .catch(() => {
                // keep the last good copy
            })
            .finally(() => {
                cache.fetchedAt = Date.now();
                cache.inflight = null;
            });
    }
    return cache.inflight;
}

/**
 * { entries, source } where source is "c0mpute" (live list) or "fallback"
 * (bundled copy). Never throws.
 */
export async function loadGallery(opts) {
    const fresh = Date.now() - cache.fetchedAt < GALLERY_TTL_MS;
    if (!fresh) {
        if (cache.entries?.length) refresh(opts); // stale: answer now, refresh behind
        else await refresh(opts);
    }
    if (cache.entries?.length) return { entries: cache.entries, source: cache.source };
    return { entries: fallbackGallery(), source: "fallback" };
}

/** Test hook. */
export function _resetGalleryCache() {
    cache.entries = null;
    cache.source = null;
    cache.fetchedAt = 0;
    cache.inflight = null;
}
