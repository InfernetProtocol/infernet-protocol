import Link from "next/link";
import { getCurrentUser } from "@/lib/supabase/auth-server";

const PUBLIC_NAV = [
    { href: "/getting-started", label: "Get started" },
    { href: "/protocol", label: "Protocol" },
    { href: "/docs", label: "Docs" },
    { href: "/chat", label: "Chat" },
    { href: "/deploy", label: "Deploy" },
    { href: "/status", label: "Status" }
];

const SIGNED_IN_NAV = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/deploy", label: "Deploy" },
    { href: "/chat", label: "Chat" },
    { href: "/status", label: "Status" },
    { href: "/invites", label: "Invites" },
    { href: "/settings", label: "Settings" }
];

export default async function SiteHeader() {
    const user = await getCurrentUser().catch(() => null);
    const nav = user ? SIGNED_IN_NAV : PUBLIC_NAV;

    return (
        <header className="border-b border-white/10 bg-[var(--bg)]/80 backdrop-blur">
            <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-6 px-6 py-4 lg:px-10">
                <Link href="/" aria-label="Infernet Protocol home" className="inline-flex">
                    <img src="/logo.svg" alt="Infernet Protocol" className="h-14 w-auto" />
                </Link>
                <nav className="hidden items-center gap-x-6 text-sm text-[var(--muted)] sm:flex">
                    {nav.map((item) => (
                        <Link key={item.href} href={item.href} className="hover:text-white">
                            {item.label}
                        </Link>
                    ))}
                    {!user && (
                        <Link
                            href="https://github.com/infernetprotocol/infernet-protocol"
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-white"
                        >
                            GitHub
                        </Link>
                    )}
                </nav>
                <div className="flex items-center gap-2">
                    {user ? (
                        <>
                            <span className="hidden text-xs text-[var(--muted)] sm:inline">
                                {user.email}
                            </span>
                            <form action="/api/auth/logout" method="post">
                                <button
                                    type="submit"
                                    className="whitespace-nowrap rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
                                >
                                    Sign out
                                </button>
                            </form>
                        </>
                    ) : (
                        <>
                            <Link
                                href="/auth/login"
                                className="hidden rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10 sm:inline-flex"
                            >
                                Sign in
                            </Link>
                            <Link
                                href="/auth/signup"
                                className="rounded-full bg-[var(--accent-strong)] px-4 py-2 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
                            >
                                Sign up
                            </Link>
                        </>
                    )}
                </div>
            </div>
        </header>
    );
}
