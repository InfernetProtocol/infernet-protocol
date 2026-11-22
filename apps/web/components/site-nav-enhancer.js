"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Progressive enhancement for the <details> menus in SiteHeader. Without this
// the menus still open, close and link; with it: one dropdown open at a time,
// Escape closes and returns focus to its toggle, a click outside closes, every
// navigation closes, and the current page's links get aria-current="page".

const MENUS = "details[data-nav-group], details[data-nav-menu]";

function closeAll(except) {
    document.querySelectorAll(`${MENUS}[open]`).forEach((d) => {
        if (d !== except) d.open = false;
    });
}

export default function SiteNavEnhancer() {
    const pathname = usePathname();

    useEffect(() => {
        closeAll();
        document.querySelectorAll("a[data-nav-link]").forEach((a) => {
            const href = a.getAttribute("href") || "";
            const path = href.split("#")[0];
            const current = path === pathname && !href.includes("#");
            if (current) a.setAttribute("aria-current", "page");
            else a.removeAttribute("aria-current");
        });
    }, [pathname]);

    useEffect(() => {
        const onToggle = (e) => {
            const d = e.target;
            if (d instanceof HTMLDetailsElement && d.matches(MENUS) && d.open) closeAll(d);
        };
        const onPointerDown = (e) => {
            document.querySelectorAll(`${MENUS}[open]`).forEach((d) => {
                if (!d.contains(e.target)) d.open = false;
            });
        };
        const onKeyDown = (e) => {
            if (e.key !== "Escape") return;
            const open = [...document.querySelectorAll(`${MENUS}[open]`)];
            if (!open.length) return;
            const focused = open.find((d) => d.contains(document.activeElement)) ?? open[0];
            open.forEach((d) => (d.open = false));
            focused.querySelector("summary")?.focus();
        };
        const onFocusIn = (e) => {
            // Tabbing out of a desktop dropdown closes it.
            document.querySelectorAll("details[data-nav-group][open]").forEach((d) => {
                if (!d.contains(e.target)) d.open = false;
            });
        };
        const onClick = (e) => {
            // Same-page links (/docs#api while on /docs) do not change the path.
            if (e.target instanceof Element && e.target.closest(`${MENUS} a`)) closeAll();
        };
        document.addEventListener("toggle", onToggle, true);
        document.addEventListener("click", onClick);
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("focusin", onFocusIn);
        return () => {
            document.removeEventListener("toggle", onToggle, true);
            document.removeEventListener("click", onClick);
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("focusin", onFocusIn);
        };
    }, []);

    return null;
}
