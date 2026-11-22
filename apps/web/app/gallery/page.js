import Link from "next/link";
import { loadGallery } from "@/lib/gallery";

export const metadata = {
    title: "Gallery: built on Infernet and c0mpute",
    description:
        "Apps, sites and agents built on the Infernet network and c0mpute: open models for inference, peer-to-peer hosting and CoinPay payments.",
    alternates: { canonical: "/gallery" }
};

const ALL = "All";

function hostOf(url) {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

function filterHref(category) {
    return category === ALL ? "/gallery" : `/gallery?category=${encodeURIComponent(category)}`;
}

export default async function GalleryPage({ searchParams }) {
    const params = (await searchParams) ?? {};
    const { entries, source } = await loadGallery();

    const categories = [ALL, ...[...new Set(entries.map((e) => e.category))].sort((a, b) => a.localeCompare(b))];
    const wanted = typeof params.category === "string" ? params.category : ALL;
    const active = categories.includes(wanted) ? wanted : ALL;
    const shown = active === ALL ? entries : entries.filter((e) => e.category === active);

    return (
        <main className="mx-auto w-full max-w-6xl px-6 py-16 lg:px-10">
            <header className="mb-10 space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Gallery</p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                    Built on Infernet.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                    Apps, sites and agents that run on the network: open models served by Infernet and c0mpute
                    nodes, sites hosted peer to peer on c0mpute, payments through CoinPay. Every entry links to
                    the live site and, where there is one, its copy on the c0mpute network.
                </p>
                <div className="flex flex-wrap gap-3 pt-2">
                    <Link
                        href="/contact?subject=Gallery%20submission"
                        className="rounded-full bg-[var(--accent-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
                    >
                        Submit your build
                    </Link>
                    <Link
                        href="/docs#api"
                        className="rounded-full border border-white/15 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
                    >
                        Build on the API
                    </Link>
                </div>
            </header>

            {categories.length > 2 ? (
                <nav aria-label="Filter by category" className="mb-8">
                    <ul className="gallery-filter">
                        {categories.map((c) => (
                            <li key={c}>
                                <Link href={filterHref(c)} aria-current={c === active ? "true" : undefined} scroll={false}>
                                    {c}
                                    {c !== ALL ? (
                                        <span className="sr-only">
                                            {" "}
                                            ({entries.filter((e) => e.category === c).length})
                                        </span>
                                    ) : null}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </nav>
            ) : null}

            <p className="sr-only" aria-live="polite">
                {shown.length} {shown.length === 1 ? "build" : "builds"}
                {active !== ALL ? ` in ${active}` : ""}
            </p>

            {shown.length ? (
                <ul className="gallery-grid subgrid-cards" data-source={source}>
                    {shown.map((e) => (
                        <li key={e.slug} className="gallery-card subgrid-card squircle" id={e.slug}>
                            <div className="gallery-card__media">
                                {e.image ? (
                                    // Remote images from the gallery list; next/image would need every host allow-listed.
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={e.image} alt="" loading="lazy" decoding="async" />
                                ) : (
                                    <span aria-hidden="true">{e.name.slice(0, 1)}</span>
                                )}
                            </div>
                            <div className="gallery-card__body">
                                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.25em] text-[var(--accent)]">
                                    {e.category}
                                </p>
                                <h2 className="text-lg font-semibold text-white">{e.name}</h2>
                                {e.tagline ? (
                                    <p className="text-sm leading-6 text-[var(--muted)]">{e.tagline}</p>
                                ) : null}
                            </div>
                            <ul className="gallery-card__chips" aria-label="Built with">
                                {e.built_with.map((b) => (
                                    <li key={b}>{b}</li>
                                ))}
                            </ul>
                            <div className="gallery-card__links">
                                <a
                                    href={e.url}
                                    target="_blank"
                                    rel="noopener"
                                    className="rounded-full bg-[var(--accent-strong)] px-4 py-2 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
                                >
                                    Visit {hostOf(e.url)}
                                    <span className="sr-only"> (opens in a new tab)</span>
                                </a>
                                {e.c0mpute_url ? (
                                    <a
                                        href={e.c0mpute_url}
                                        target="_blank"
                                        rel="noopener"
                                        className="rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
                                    >
                                        c0mpute copy
                                        <span className="sr-only"> of {e.name} (opens in a new tab)</span>
                                    </a>
                                ) : null}
                            </div>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-[var(--muted)]">
                    Nothing in {active} yet. <Link href="/gallery" className="text-[var(--accent)] hover:underline">Show everything</Link>.
                </p>
            )}

            <section className="mt-16 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-8">
                <h2 className="text-2xl font-semibold text-white">Built something on Infernet or c0mpute?</h2>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">
                    Send us the link, a line about what it does and what it runs on (Infernet chat or API, c0mpute
                    hosting, CoinPay). Listed builds show here and on c0mpute.com.
                </p>
                <div className="mt-5 flex flex-wrap gap-3">
                    <Link
                        href="/contact?subject=Gallery%20submission"
                        className="rounded-full bg-[var(--accent-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
                    >
                        Submit your build
                    </Link>
                    <a
                        href="https://c0mpute.com"
                        className="rounded-full border border-white/15 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
                    >
                        Host it on c0mpute
                    </a>
                </div>
            </section>
        </main>
    );
}
