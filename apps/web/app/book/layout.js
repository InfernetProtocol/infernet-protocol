import Link from "next/link";
import { getBookToc } from "@/lib/book";

export const metadata = {
    title: "The Infernet Protocol Book",
    description: "The complete open-source guide to decentralized GPU inference — for node operators and application developers."
};

export default function BookLayout({ children }) {
    const toc = getBookToc();

    return (
        <div className="mx-auto flex w-full max-w-7xl gap-8 px-4 py-10 sm:px-6 lg:px-10">
            {/* Sidebar */}
            <aside className="hidden w-56 shrink-0 lg:block">
                <div className="sticky top-24 space-y-6">
                    <Link href="/book" className="block text-sm font-semibold text-white hover:text-[var(--accent)]">
                        The Infernet Book
                    </Link>
                    <nav className="space-y-4 text-sm">
                        <Link href="/book" className="block text-[var(--muted)] hover:text-white">
                            Introduction
                        </Link>
                        {toc.map((section) => (
                            <div key={section.slug}>
                                {/* Chapter pages are static pandoc-built .html
                                    files served from /book/<path>.html, so we
                                    use plain anchors instead of next/link. */}
                                <a href={section.href} className="block font-medium text-white hover:text-[var(--accent)]">
                                    {section.title}
                                </a>
                                {section.pages.length > 0 && (
                                    <ul className="mt-1 space-y-1 border-l border-white/10 pl-3">
                                        {section.pages.map((page) => (
                                            <li key={page.slug}>
                                                <a href={page.href} className="block text-[var(--muted)] hover:text-white">
                                                    {page.title}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        ))}
                    </nav>
                    <div className="border-t border-white/10 pt-4 space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Download</p>
                        <a href="/book/infernet-book.pdf" className="block text-xs text-[var(--muted)] hover:text-white">PDF</a>
                        <a href="/book/infernet-book.epub" className="block text-xs text-[var(--muted)] hover:text-white">EPUB</a>
                    </div>
                </div>
            </aside>

            {/* Content */}
            <main className="min-w-0 flex-1">
                {children}
            </main>
        </div>
    );
}
