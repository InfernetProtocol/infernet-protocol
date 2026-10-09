// Next.js App Router sitemap. Serves /sitemap.xml with the public,
// indexable routes. Auth-gated pages (/dashboard, /settings, /auth/*),
// API routes, and dynamic [id] pages are intentionally excluded.
const BASE_URL =
    process.env.NEXT_PUBLIC_APP_URL ?? "https://infernetprotocol.com";

// Routes that make sense for a crawler / answer engine to index, with a
// rough priority ordering. Keep this list in sync as public pages are added.
const ROUTES = [
    { path: "/", priority: 1.0, changeFrequency: "daily" },
    { path: "/getting-started", priority: 0.9, changeFrequency: "weekly" },
    { path: "/protocol", priority: 0.9, changeFrequency: "weekly" },
    { path: "/docs", priority: 0.9, changeFrequency: "weekly" },
    { path: "/docs/managed-endpoints", priority: 0.7, changeFrequency: "monthly" },
    { path: "/book", priority: 0.7, changeFrequency: "weekly" },
    { path: "/chat", priority: 0.8, changeFrequency: "weekly" },
    { path: "/deploy", priority: 0.7, changeFrequency: "weekly" },
    { path: "/status", priority: 0.6, changeFrequency: "hourly" },
    { path: "/cpu", priority: 0.5, changeFrequency: "weekly" },
    { path: "/gpu", priority: 0.5, changeFrequency: "weekly" },
    { path: "/faq", priority: 0.6, changeFrequency: "weekly" },
    { path: "/contact", priority: 0.5, changeFrequency: "monthly" },
    { path: "/careers", priority: 0.4, changeFrequency: "monthly" },
    { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
    { path: "/terms", priority: 0.3, changeFrequency: "yearly" }
];

export default function sitemap() {
    const lastModified = new Date();
    return ROUTES.map(({ path, priority, changeFrequency }) => ({
        url: `${BASE_URL}${path}`,
        lastModified,
        changeFrequency,
        priority
    }));
}
