// The pit.world global footer: fetched server-side, rendered last in <body>.
// The layout is force-dynamic (which turns fetch caching off), so the snippet
// is cached here in module scope for an hour and served stale when pit.world
// is slow or down. Any failure with nothing cached renders nothing.
const PIT_FOOTER_URL = "https://pit.world/snippets/footer.html?site=infernetprotocol.com";
const TTL_MS = 60 * 60 * 1000;
const cache = { html: "", fetchedAt: 0 };

async function loadPitFooter() {
    if (Date.now() - cache.fetchedAt < TTL_MS) return cache.html;
    cache.fetchedAt = Date.now();
    try {
        const res = await fetch(PIT_FOOTER_URL, {
            cache: "no-store",
            signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
            const html = await res.text();
            if (html.includes("data-pit-footer")) cache.html = html;
        }
    } catch {
        // keep the last good copy
    }
    return cache.html;
}

export default async function PitFooter() {
    const html = await loadPitFooter();
    if (!html) return null;
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
