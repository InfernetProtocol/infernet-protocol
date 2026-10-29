import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import ContactDetailsForm from "@/components/contact-details-form";
import { creditSummary, settleInviteBonus } from "@/lib/credits";
import { coinpayConfig, isPlaceholderEmail, supabaseCoinpayStore } from "@/lib/auth/coinpay-signin";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Settings — Infernet"
};

/**
 * Account-level settings + per-node privacy.
 *
 * `default_is_public` (on pubkey_links) sets the default for any new
 * node the operator registers. Per-node toggles flip is_public on the
 * specific provider/aggregator/client row.
 *
 * Posting to /api/v1/user/settings updates both. Nodes opted out of
 * public listing don't appear in /status, /chat routing for non-owner
 * traffic, /api/peers, or the public /nodes/:id page.
 */
export default async function SettingsPage({ searchParams }) {
    const user = await getCurrentUser();
    if (!user) redirect("/auth/login?next=/settings");

    const params = (await searchParams) ?? {};
    const saved = params.saved === "1";
    const error = typeof params.error === "string" ? params.error : null;
    const creditOk = typeof params.credit_ok === "string" ? params.credit_ok : null;
    const creditError = typeof params.credit_error === "string" ? params.credit_error : null;
    const creditMonthly = params.monthly === "1";

    // Consumer compute credits (never provider earnings, never withdrawable).
    let credits = null;
    try {
        await settleInviteBonus(user.id);
        credits = await creditSummary(user.id);
    } catch (err) {
        console.error("[settings] credits unavailable", err?.message ?? err);
    }

    const supabase = getSupabaseServerClient();
    const [{ data: links }, { data: providers }] = await Promise.all([
        supabase
            .from("pubkey_links")
            .select("id, pubkey, role, label, default_is_public, created_at")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false }),
        supabase
            .from("providers")
            .select("id, name, node_id, status, is_public, public_key")
            .in(
                "public_key",
                (await supabase.from("pubkey_links").select("pubkey").eq("user_id", user.id))
                    ?.data?.map((r) => r.pubkey) ?? ["__none__"]
            )
    ]);

    const defaultIsPublic = links?.[0]?.default_is_public ?? true;

    // Sign in with CoinPay: the identity bound to this account, if any.
    const coinpayOn = Boolean(coinpayConfig());
    const coinpayOnly = isPlaceholderEmail(user.email);
    let coinpay = null;
    if (coinpayOn) {
        try {
            coinpay = await supabaseCoinpayStore(supabase).identityByUser(user.id);
        } catch (err) {
            console.error("[settings] coinpay identity unavailable", err?.message ?? err);
        }
    }
    const coinpayConnected = params.coinpay === "connected";
    const coinpayDisconnected = params.coinpay === "disconnected";

    return (
        <main className="mx-auto w-full max-w-3xl px-6 py-12 lg:px-10">
            <header className="mb-8 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
                    Settings
                </p>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                    Account, credits &amp; node privacy
                </h1>
                <p className="text-sm text-[var(--muted)]">
                    Signed in as <span className="font-mono text-white">{coinpayOnly ? "your CoinPay account" : (user.email ?? user.id)}</span>.
                </p>
            </header>

            {saved ? (
                <div className="mb-6 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-200">
                    Settings saved.
                </div>
            ) : null}
            {error ? (
                <div className="mb-6 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
                    {error}
                </div>
            ) : null}

            <section id="credits" className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <h2 className="text-lg font-semibold text-white">Compute credits</h2>
                    <p className="text-sm text-[var(--muted)]">
                        Balance:{" "}
                        <span className="font-mono text-base text-white">
                            {credits ? credits.balance.toLocaleString("en-US") : "unavailable"}
                        </span>
                    </p>
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    Credits are for using the network as a customer. They are separate from the
                    earnings your nodes make and cannot be withdrawn.
                </p>
                {creditOk ? (
                    <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-200">
                        Code redeemed: +{Number(creditOk).toLocaleString("en-US")} credits{creditMonthly ? " every month" : ""}.
                    </div>
                ) : null}
                {creditError ? (
                    <div className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
                        {creditError}
                    </div>
                ) : null}
                <form action="/api/v1/credits/redeem" method="post" className="mt-4 flex flex-col gap-3 sm:flex-row">
                    <label className="sr-only" htmlFor="credit-code">Have a code?</label>
                    <input
                        id="credit-code"
                        name="code"
                        required
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="Have a code? CR-XXXX-XXXX-XXXX-XXXX"
                        className="min-w-0 flex-1 rounded-full border border-white/15 bg-[var(--panel-strong)] px-4 py-2 font-mono text-sm text-white placeholder:text-[var(--muted)]"
                    />
                    <button
                        type="submit"
                        className="rounded-full bg-[var(--accent-strong)] px-5 py-2 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
                    >
                        Redeem
                    </button>
                </form>
                {credits?.history?.length ? (
                    <ul className="mt-4 space-y-1 text-xs text-[var(--muted)]">
                        {credits.history.slice(0, 5).map((h, i) => (
                            <li key={`${h.at}-${i}`}>
                                {h.kind === "spend" ? "-" : "+"}
                                {h.amount.toLocaleString("en-US")} · {h.source} · {h.at.slice(0, 10)}
                            </li>
                        ))}
                    </ul>
                ) : null}
                <p className="mt-4 text-sm text-[var(--muted)]">
                    <Link href="/invites" className="text-[var(--accent)] hover:underline">
                        Invite someone
                    </Link>{" "}
                    — you both get credits when they join.
                </p>
            </section>

            {coinpayOn ? (
                <section id="coinpay" className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">CoinPay</h2>
                    {coinpayConnected ? (
                        <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-200">
                            CoinPay connected. You can sign in with it now.
                        </div>
                    ) : null}
                    {coinpayDisconnected ? (
                        <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-200">
                            CoinPay disconnected.
                        </div>
                    ) : null}
                    {coinpay ? (
                        <>
                            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                                Connected: you can sign in with CoinPay.
                                {coinpayOnly ? " It is how you sign in to this account, so it stays connected." : ""}
                            </p>
                            {coinpayOnly ? null : (
                                <form action="/api/v1/coinpay/disconnect" method="post" className="mt-4">
                                    <button type="submit" className="rounded-full border border-white/15 px-5 py-2 text-sm text-white transition hover:border-red-400/60">
                                        Disconnect CoinPay
                                    </button>
                                </form>
                            )}
                        </>
                    ) : (
                        <>
                            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                                Sign in to Infernet with your CoinPay account.
                            </p>
                            <form action="/api/v1/coinpay/oauth/start" method="post" className="mt-4">
                                <input type="hidden" name="mode" value="connect" />
                                <button type="submit" className="rounded-full bg-[var(--accent-strong)] px-5 py-2 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]">
                                    Connect CoinPay
                                </button>
                            </form>
                        </>
                    )}
                </section>
            ) : null}

            <form action="/api/v1/user/settings" method="post" className="space-y-8">
                <section className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">Default node visibility</h2>
                    <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                        Applied to <em>new</em> nodes you register. Existing nodes keep their
                        per-node setting (toggle each below).
                    </p>
                    <div className="mt-4 flex items-center gap-3">
                        <label className="inline-flex items-center gap-2">
                            <input
                                type="radio"
                                name="default_is_public"
                                value="true"
                                defaultChecked={defaultIsPublic}
                            />
                            <span className="text-sm text-white">Public — listed on /status, /nodes/:id, etc.</span>
                        </label>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                        <label className="inline-flex items-center gap-2">
                            <input
                                type="radio"
                                name="default_is_public"
                                value="false"
                                defaultChecked={!defaultIsPublic}
                            />
                            <span className="text-sm text-white">Private — only you and routed jobs see it</span>
                        </label>
                    </div>
                </section>

                <section className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">Your nodes</h2>
                    <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                        Toggle each node&apos;s public visibility independently. Private
                        nodes can still receive jobs you submit; they just don&apos;t
                        appear in public listings.
                    </p>
                    {(providers?.length ?? 0) === 0 ? (
                        <p className="mt-4 text-sm text-[var(--muted)]">
                            No providers registered yet. Mint a deploy token at{" "}
                            <Link href="/deploy" className="text-[var(--accent)] hover:underline">
                                /deploy
                            </Link>
                            .
                        </p>
                    ) : (
                        <ul className="mt-4 space-y-2">
                            {providers.map((p) => (
                                <li
                                    key={p.id}
                                    className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-[var(--panel-strong)] px-4 py-3"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium text-white">
                                            {p.name ?? p.node_id ?? "(unnamed)"}
                                        </p>
                                        <p className="truncate text-xs text-[var(--muted)]">
                                            {p.node_id} · status: {p.status}
                                        </p>
                                    </div>
                                    <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
                                        <input
                                            type="checkbox"
                                            name={`node_public[${p.id}]`}
                                            value="true"
                                            defaultChecked={p.is_public !== false}
                                        />
                                        <span>Public</span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <button
                    type="submit"
                    className="rounded-full bg-[var(--accent-strong)] px-6 py-3 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
                >
                    Save settings
                </button>
            </form>

            <ContactDetailsForm />
        </main>
    );
}
