/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@infernetprotocol/config",
    "@infernetprotocol/payments",
    "@infernetprotocol/deploy-providers",
    "@infernetprotocol/nim-adapter",
    "@infernetprotocol/db",
    "@infernetprotocol/gpu",
    "@infernetprotocol/auth",
    "@infernetprotocol/logger",
    "@infernetprotocol/inference"
  ],
  // Next.js 16 moved this out of `experimental` to the top level.
  typedRoutes: false,
  // Security headers. The five enforcing headers below are safe for a
  // Next.js + Supabase app; X-Frame-Options handles the clickjacking
  // finding. CSP ships as Report-Only first (the recommended way to
  // roll out a policy) so it can be tightened into enforcement without
  // risking a broken page.
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://crawlproof.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self' https://pit.world", // the footer newsletter form's no-script fallback
      "object-src 'none'"
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains"
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin"
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()"
          },
          { key: "Content-Security-Policy-Report-Only", value: csp }
        ]
      }
    ];
  },
  // Forward old extensionless chapter URLs to the new pandoc-built
  // .html files under /book/<path>.html.
  async redirects() {
    return [
      {
        source: "/book/:section(\\d{2}-[^/.]+)",
        destination: "/book/:section/index.html",
        permanent: true
      },
      {
        // Constrain :page to NOT contain a dot, otherwise the existing
        // /book/<section>/<page>.html files match this rule and redirect
        // back to themselves with another .html appended (loop).
        source: "/book/:section(\\d{2}-[^/.]+)/:page([^/.]+)",
        destination: "/book/:section/:page.html",
        permanent: true
      }
    ];
  }
};

export default nextConfig;
