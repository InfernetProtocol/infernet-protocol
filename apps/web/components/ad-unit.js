"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

/**
 * CrawlProof ad unit for infernetprotocol.com. Manage the slot at
 * https://crawlproof.com/ads/slots
 */
const AD_SLOT = "c8310890-a340-42a7-85af-81f7228514fa";

/** Low profile only: the thin fluid text_link line (40px at any width). */
const FORMAT = "text_link";

const SCAN_RETRY_MS = 200;
const SCAN_MAX_TRIES = 25;

/**
 * ad.js scans for [data-cp-ad] once, at DOMContentLoaded. This unit is rendered
 * without data-slot on the server (so that pass skips it), sets its format on mount, then asks ad.js to fill it, retrying while ad.js is
 * still loading and giving up after ~5s so a blocker never leaves a timer
 * running. Zero height until ad.js marks it data-cp-filled (globals.css).
 */
export default function AdUnit({ className = "" }) {
    const [format, setFormat] = useState(null);

    useEffect(() => {
        setFormat(FORMAT);
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
        <div className={`mx-auto my-2 w-full max-w-6xl px-6 lg:px-10 ${className}`.trim()}>
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
