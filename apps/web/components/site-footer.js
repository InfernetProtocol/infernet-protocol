import Link from "next/link";

const PRODUCT = [
    { href: "/getting-started", label: "Get started" },
    { href: "/protocol", label: "Protocol" },
    { href: "/docs", label: "Docs" },
    { href: "/book", label: "Book" },
    { href: "/faq", label: "FAQ" },
    { href: "/chat", label: "Chat" },
    { href: "/deploy", label: "Deploy" },
    { href: "/status", label: "Status" }
];

const COMPANY = [
    { href: "/careers", label: "Careers" },
    { href: "/contact", label: "Contact" },
    { href: "/terms", label: "Terms" },
    { href: "/privacy", label: "Privacy" },
    {
        href: "https://github.com/infernetprotocol/infernet-protocol",
        label: "GitHub",
        external: true
    }
];

const BOOK_DOWNLOADS = [
    { href: "/book/infernet-book.pdf", label: "PDF", external: true },
    { href: "/book/infernet-book.epub", label: "EPUB", external: true },
    { href: "/whitepaper/infernet-whitepaper.pdf", label: "Whitepaper (PDF)", external: true, icon: "pdf" }
];

export default function SiteFooter() {
    return (
        <footer className="mx-auto w-full max-w-6xl px-6 py-12 lg:px-10">
            <div className="grid gap-10 border-t border-white/10 pt-10 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
                <div className="space-y-3">
                    <Link href="/" aria-label="Infernet Protocol home" className="inline-flex">
                        <img src="/logo.svg" alt="Infernet Protocol" className="h-14 w-auto" />
                    </Link>
                    <p className="max-w-sm text-sm leading-6 text-[var(--muted)]">
                        Decentralized GPU compute for inference and distributed training. No native
                        token, no rent extraction.
                    </p>
                    <div className="flex items-center gap-4 text-sm text-[var(--muted)]">
                        <a href="mailto:hello@infernetprotocol.com" className="hover:text-white">
                            hello@infernetprotocol.com
                        </a>
                        <a
                            href="https://discord.gg/w5nHdzpQ29"
                            target="_blank"
                            rel="noreferrer"
                            aria-label="Join our Discord"
                            className="hover:text-white transition-colors"
                        >
                            <DiscordIcon />
                        </a>
                    </div>
                </div>

                <FooterColumn title="Product" items={PRODUCT} />
                <FooterColumn title="Company" items={COMPANY} />
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">The Book</p>
                    <div className="mt-4 flex items-start gap-3">
                        <Link href="/book">
                            <img src="/book/cover.jpg" alt="The Infernet Protocol Book" className="w-12 rounded shadow-md opacity-90 hover:opacity-100 transition-opacity" />
                        </Link>
                        <ul className="space-y-2 text-sm">
                            {BOOK_DOWNLOADS.map((item) => (
                                <li key={item.href}>
                                    <a href={item.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[var(--muted)] hover:text-white">
                                        {item.icon === "pdf" && <PdfIcon />}
                                        {item.label}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>

            <div className="mt-10 flex flex-col gap-3 border-t border-white/10 pt-6 text-sm text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between">
                <p>© {new Date().getFullYear()} Infernet Protocol — open source, MIT licensed.</p>
                <nav className="webring flex items-center gap-2" aria-label="Profullstack webring">
                    <a href="https://rssamplifier.com/ring/profullstack/previous?from=https%3A%2F%2Finfernetprotocol.com%2F" rel="prev" className="hover:text-white">{"<<"}</a>
                    <a href="https://rssamplifier.com/ring/profullstack" className="hover:text-white">Profullstack</a>
                    <a href="https://rssamplifier.com/ring/profullstack/next?from=https%3A%2F%2Finfernetprotocol.com%2F" rel="next" className="hover:text-white">{">>"}</a>
                    <a href="https://rssamplifier.com/ring/profullstack/random?from=https%3A%2F%2Finfernetprotocol.com%2F" title="Random site" aria-label="Random site" className="hover:text-white">{"⚄"}</a>
                </nav>
                <p>
                    <Link href="/auth/login" className="hover:text-white">
                        Sign in
                    </Link>
                </p>
            </div>
        </footer>
    );
}

function PdfIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6zm2.5-5.5h1.2c.7 0 1.3-.6 1.3-1.3v-.4c0-.7-.6-1.3-1.3-1.3H8v4h.5v-1zm0-2.5h.7c.4 0 .8.3.8.8v.4c0 .4-.3.8-.8.8H8.5v-2zm3.5 0h1c1.1 0 2 .9 2 2s-.9 2-2 2h-1v-4zm.5 3.5h.5c.8 0 1.5-.7 1.5-1.5S15.3 13 14.5 13H14v2.5zm3.5-3.5h2.5v.5H18v1h1.5v.5H18V18h-.5v-4z"/>
        </svg>
    );
}

function DiscordIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
    );
}

function FooterColumn({ title, items }) {
    return (
        <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                {title}
            </p>
            <ul className="mt-4 space-y-2 text-sm">
                {items.map((item) => (
                    <li key={item.href}>
                        <Link
                            href={item.href}
                            className="text-[var(--muted)] hover:text-white"
                            target={item.external ? "_blank" : undefined}
                            rel={item.external ? "noreferrer" : undefined}
                        >
                            {item.label}
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}
