import { coinpayConfig } from "@/lib/auth/coinpay-signin";

/**
 * "Sign in with CoinPay": the first option on /auth/login and /auth/signup.
 * A plain link to the start route (a full-page redirect to coinpayportal.com),
 * so it works without JavaScript. Renders nothing when no client is configured.
 */
export default function CoinpaySigninButton({ next, label = "Sign in with CoinPay" }) {
    if (!coinpayConfig()) return null;
    const href = `/api/v1/coinpay/oauth/start${next ? `?next=${encodeURIComponent(next)}` : ""}`;
    return (
        <div className="mb-6">
            <a
                href={href}
                className="block w-full rounded-full border border-white/15 bg-white/5 px-6 py-3 text-center text-sm font-semibold text-white transition hover:border-[var(--accent)] hover:bg-white/10"
            >
                {label}
            </a>
            <div className="mt-6 flex items-center gap-3 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                <span className="h-px flex-1 bg-white/10" />
                or with email
                <span className="h-px flex-1 bg-white/10" />
            </div>
        </div>
    );
}
