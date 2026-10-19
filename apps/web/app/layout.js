import "./globals.css";
import Script from "next/script";
import SiteHeader from "@/components/site-header";
import SiteFooter from "@/components/site-footer";
import PitFooter from "@/components/pit-footer";

export const metadata = {
    metadataBase: new URL(
        process.env.NEXT_PUBLIC_APP_URL ?? "https://infernetprotocol.com"
    ),
    title: {
        default: "Infernet Protocol — Decentralized GPU compute",
        template: "%s · Infernet Protocol"
    },
    description:
        "A peer-to-peer GPU compute marketplace for inference and distributed training. Run one CLI command, point it at the hardware you have, and start earning crypto. No native token, no rent extraction.",
    applicationName: "Infernet Protocol",
    appleWebApp: {
        capable: true,
        title: "Infernet",
        statusBarStyle: "black-translucent"
    },
    formatDetection: {
        telephone: false
    },
    openGraph: {
        title: "Infernet Protocol — We're doing to AI what Bitcoin did to money",
        description:
            "Decentralized GPU compute for inference and training. Operators earn crypto for the GPUs they already have; clients pay in any supported coin.",
        type: "website",
        siteName: "Infernet Protocol",
        url: "/",
        images: [{ url: "/og-image.png", width: 1200, height: 630 }]
    },
    twitter: {
        card: "summary_large_image",
        title: "Infernet Protocol — We're doing to AI what Bitcoin did to money",
        description:
            "Decentralized GPU compute — inference and distributed training. No native token, no rent extraction, no permission required.",
        site: "@infernetproto",
        images: ["/og-image.png"]
    },
    manifest: "/manifest.json",
    icons: {
        icon: [
            { url: "/favicon.svg", type: "image/svg+xml" },
            { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
            { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" }
        ],
        shortcut: "/favicon.ico",
        apple: [
            { url: "/icons/apple-touch-icon-180x180.png", sizes: "180x180" },
            { url: "/icons/apple-touch-icon-152x152.png", sizes: "152x152" },
            { url: "/icons/apple-touch-icon-144x144.png", sizes: "144x144" },
            { url: "/icons/apple-touch-icon-120x120.png", sizes: "120x120" },
            { url: "/icons/apple-touch-icon-114x114.png", sizes: "114x114" },
            { url: "/icons/apple-touch-icon-76x76.png",   sizes: "76x76" },
            { url: "/icons/apple-touch-icon-72x72.png",   sizes: "72x72" },
            { url: "/icons/apple-touch-icon-60x60.png",   sizes: "60x60" },
            { url: "/icons/apple-touch-icon-57x57.png",   sizes: "57x57" }
        ]
    },
    other: {
        "msapplication-TileColor": "#0a0a0a",
        "msapplication-TileImage": "/icons/apple-touch-icon-144x144.png",
        "msapplication-config": "/browserconfig.xml",
        "mobile-web-app-capable": "yes"
    }
};

export const viewport = {
    width: "device-width",
    initialScale: 1,
    themeColor: "#0a0a0a",
    colorScheme: "dark"
};

const SITE_URL =
    process.env.NEXT_PUBLIC_APP_URL ?? "https://infernetprotocol.com";

// JSON-LD structured data so search + answer engines can resolve
// "Infernet Protocol" as a distinct entity and describe the product
// without guessing. Rendered as a single @graph in one script tag.
const JSON_LD = {
    "@context": "https://schema.org",
    "@graph": [
        {
            "@type": "Organization",
            "@id": `${SITE_URL}/#organization`,
            name: "Infernet Protocol",
            url: SITE_URL,
            logo: `${SITE_URL}/logo.svg`,
            description:
                "A peer-to-peer GPU compute marketplace for inference and distributed training. No native token, no rent extraction.",
            email: "hello@infernetprotocol.com",
            sameAs: [
                "https://github.com/InfernetProtocol/infernet-protocol",
                "https://x.com/infernetproto"
            ]
        },
        {
            "@type": "WebSite",
            "@id": `${SITE_URL}/#website`,
            url: SITE_URL,
            name: "Infernet Protocol",
            publisher: { "@id": `${SITE_URL}/#organization` },
            description:
                "Decentralized GPU compute for inference and training. Operators earn crypto for the GPUs they already have; clients pay in any supported coin."
        },
        {
            "@type": "SoftwareApplication",
            "@id": `${SITE_URL}/#software`,
            name: "Infernet Protocol",
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Linux, macOS, Windows (WSL2)",
            url: SITE_URL,
            downloadUrl: `${SITE_URL}/install.sh`,
            softwareHelp: `${SITE_URL}/docs`,
            publisher: { "@id": `${SITE_URL}/#organization` },
            description:
                "Run one CLI command, point it at the hardware you have, and start earning crypto for inference and distributed-training jobs. Operators authenticate with a Nostr keypair; the control plane is convenience, not dependency.",
            offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
                description:
                    "Open-source and free to run. Operators are paid in crypto for jobs they serve; clients pay per job in any supported coin."
            }
        }
    ]
};

// SiteHeader (rendered on every route below) is an async server component
// that reads per-request auth via cookies(). Under Next 16, a page that is
// otherwise static-eligible (/, /careers, /faq, /terms, ...) gets statically
// prerendered and then throws "Page changed from static to dynamic at runtime,
// reason: cookies" at request time — a 500 on nearly every content page.
// Since the shared header genuinely depends on the request cookies, no page
// under this layout can be static; mark the whole tree dynamic.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <body className="flex min-h-screen flex-col">
                <script
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
                />
                {/* SiteHeader is async (reads the user) — Next.js handles
                    the suspense boundary automatically. */}
                <SiteHeader />
                <div className="flex-1">{children}</div>
                <SiteFooter />
                <Script
                    src="https://crawlproof.com/stats.js"
                    data-site="a5ab20bb-34d5-4799-9c08-8620647ce772"
                    strategy="afterInteractive"
                />
                <PitFooter />
            </body>
        </html>
    );
}
