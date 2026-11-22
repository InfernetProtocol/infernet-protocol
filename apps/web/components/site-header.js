import Link from "next/link";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { FEATURED, navGroups } from "@/lib/nav";
import SiteNavEnhancer from "@/components/site-nav-enhancer";

// Grouped header. Desktop (lg+): a featured Gallery link plus one <details>
// dropdown per group. Phones and tablets: one <details> "Menu" that opens a
// full-screen panel listing every group. Both are plain <details>/<summary>, so
// every link works without JavaScript; SiteNavEnhancer only adds closing on
// Escape / outside click / navigation and one-panel-at-a-time.

function NavLink({ item, className, children }) {
    if (item.external) {
        return (
            <a href={item.href} target="_blank" rel="noreferrer" className={className}>
                {children}
            </a>
        );
    }
    return (
        <Link href={item.href} className={className} data-nav-link="">
            {children}
        </Link>
    );
}

function Chevron() {
    return (
        <svg className="site-nav__chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function GroupItems({ group }) {
    return (
        <ul className="site-nav__items">
            {group.items.map((item) => (
                <li key={`${group.id}:${item.href}:${item.label}`}>
                    <NavLink item={item} className="site-nav__item">
                        <span className="site-nav__item-label">
                            {item.label}
                            {item.external ? <span aria-hidden="true"> ↗</span> : null}
                        </span>
                        {item.hint ? <span className="site-nav__item-hint">{item.hint}</span> : null}
                    </NavLink>
                </li>
            ))}
        </ul>
    );
}

export default async function SiteHeader() {
    const user = await getCurrentUser().catch(() => null);
    const groups = navGroups(user);

    return (
        <header className="site-header stuck-header">
            <div className="site-header__bar stuck-header-bar">
                <div className="site-header__inner">
                    <Link href="/" aria-label="Infernet Protocol home" className="site-header__logo">
                        <img src="/logo.svg" alt="Infernet Protocol" />
                    </Link>

                    <nav className="site-nav" aria-label="Main">
                        <ul className="site-nav__bar">
                            <li>
                                <Link href={FEATURED.href} className="site-nav__featured" data-nav-link="">
                                    {FEATURED.label}
                                </Link>
                            </li>
                            {groups.map((group, i) => (
                                <li key={group.id}>
                                    <details className="site-nav__group" data-nav-group="">
                                        <summary className="site-nav__trigger">
                                            {group.label}
                                            <Chevron />
                                        </summary>
                                        <div
                                            className={`site-nav__panel squircle${group.items.length > 6 ? " site-nav__panel--wide" : ""}`}
                                            data-align={i >= groups.length - 2 ? "end" : "start"}
                                        >
                                            <GroupItems group={group} />
                                        </div>
                                    </details>
                                </li>
                            ))}
                        </ul>
                    </nav>

                    <div className="site-header__actions">
                        {user ? (
                            <>
                                <span className="site-header__email">{user.email}</span>
                                <form action="/api/auth/logout" method="post">
                                    <button type="submit" className="site-btn site-btn--ghost">
                                        Sign out
                                    </button>
                                </form>
                            </>
                        ) : (
                            <>
                                <Link href="/auth/login" className="site-btn site-btn--ghost site-btn--wide-only">
                                    Sign in
                                </Link>
                                <Link href="/auth/signup" className="site-btn site-btn--primary">
                                    Sign up
                                </Link>
                            </>
                        )}

                        <details className="site-menu" data-nav-menu="">
                            <summary className="site-menu__toggle">
                                <span className="site-menu__open-label">Menu</span>
                                <span className="site-menu__close-label">Close</span>
                            </summary>
                            <div className="site-menu__panel">
                                <nav aria-label="Main" className="site-menu__nav">
                                    <Link href={FEATURED.href} className="site-menu__featured" data-nav-link="">
                                        <span className="site-nav__item-label">{FEATURED.label}</span>
                                        <span className="site-nav__item-hint">{FEATURED.hint}</span>
                                    </Link>
                                    <div className="site-menu__groups">
                                        {groups.map((group) => (
                                            <section key={group.id} aria-labelledby={`menu-${group.id}`}>
                                                <h2 id={`menu-${group.id}`} className="site-menu__heading">
                                                    {group.label}
                                                </h2>
                                                <GroupItems group={group} />
                                            </section>
                                        ))}
                                    </div>
                                    {!user ? (
                                        <p className="site-menu__auth">
                                            <Link href="/auth/login" className="site-btn site-btn--ghost">
                                                Sign in
                                            </Link>
                                        </p>
                                    ) : null}
                                </nav>
                            </div>
                        </details>
                    </div>
                </div>
            </div>
            <SiteNavEnhancer />
        </header>
    );
}
