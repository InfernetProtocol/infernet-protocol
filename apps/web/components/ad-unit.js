"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

/**
 * CrawlProof ad unit for infernetprotocol.com. Manage the slot at
 * https://crawlproof.com/ads/slots
 */
const AD_SLOT = "c8310890-a340-42a7-85af-81f7228514fa";

/** 728x90 needs the full content column; anything narrower gets the 300x250. */
const LEADERBOARD_QUERY = "(min-width: 768px)";

const SCAN_RETRY_MS = 200;
const SCAN_MAX_TRIES = 25;

/**
 * ad.js scans for [data-cp-ad] once, at DOMContentLoaded. This unit is rendered
 * without data-slot on the server (so that pass skips it), picks one format from
 * the viewport on mount, then asks ad.js to fill it, retrying while ad.js is
 * still loading and giving up after ~5s so a blocker never leaves a timer
 * running. Zero height until ad.js marks it data-cp-filled (globals.css).
 */
export default function AdUnit({ className = "" }) {
    const [format, setFormat] = useState(null);

    useEffect(() => {
        setFormat(window.matchMedia(LEADERBOARD_QUERY).matches ? "banner_728x90" : "banner_300x250");
    }, []);

    useEffect(() => {
        if (!format) return undefined;
        let cancelled = false;
        let tries = 0;
        let timer;
        const tick = () => {
            if (cancelled) return;
            if (window.crawlproofAds) {
                window.crawlproofAds.scan();
                return;
            }
            if (++tries > SCAN_MAX_TRIES) return;
            timer = setTimeout(tick, SCAN_RETRY_MS);
        };
        tick();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [format]);

    return (
        <div className={`mx-auto flex w-full max-w-6xl justify-center px-6 lg:px-10 ${className}`.trim()}>
            <div
                className="cp-ad"
                data-cp-ad=""
                data-slot={format ? AD_SLOT : undefined}
                data-format={format ?? undefined}
            />
            <Script src="https://crawlproof.com/ad.js" strategy="afterInteractive" />
        </div>
    );
}
