import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { inviteOverview, settleInvitesSentBy, settleInviteBonus } from "@/lib/credits";
import { FLASH_COOKIE, inviteUrl, refUrl, publicOrigin, looksLikeCode, INVITE_QUOTA } from "@/lib/credits/core";
import CopyButton from "@/components/copy-button";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Invites — Infernet",
    robots: { index: false }
};

const BONUS_LABEL = {
    granted: "bonus paid",
    pending: "bonus when they confirm their email",
    denied: "no bonus"
};

function Notice({ tone = "ok", children }) {
    const cls =
        tone === "ok"
            ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
            : "border-red-400/30 bg-red-400/10 text-red-200";
    return <div className={`mb-6 rounded-lg border p-3 text-sm ${cls}`}>{children}</div>;
}

/**
 * /invites — scarce invite codes (INVITE_QUOTA per account) plus the open
 * ?ref= affiliate link. Both people get compute credits when a new account
 * joins on an invite and confirms its email.
 */
export default async function InvitesPage({ searchParams }) {
    const user = await getCurrentUser();
    const params = (await searchParams) ?? {};
    const accept = typeof params.accept === "string" && looksLikeCode(params.accept) ? params.accept : null;
    if (!user) redirect(accept ? `/auth/signup?invite=${encodeURIComponent(accept)}` : "/auth/login?next=/invites");

    const origin = publicOrigin({ headers: await headers() });
    const created = params.created === "1" ? (await cookies()).get(FLASH_COOKIE)?.value ?? null : null;
    const error = typeof params.error === "string" ? params.error : null;
    const joined = typeof params.joined === "string" ? params.joined : null;

    let o = null;
    try {
        await settleInvitesSentBy(user.id);
        await settleInviteBonus(user.id);
        o = await inviteOverview(user.id);
    } catch (err) {
        console.error("[invites] page failed", err?.message ?? err);
    }

    return (
        <main className="mx-auto w-full max-w-3xl px-6 py-12 lg:px-10">
            <header className="mb-8 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Invites</p>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Invite someone to Infernet</h1>
                <p className="text-sm leading-6 text-[var(--muted)]">
                    You have {INVITE_QUOTA} invites. Each works once and expires in 30 days. When a new account joins on
                    yours and confirms its email, you both get {o ? o.bonusCredits : "bonus"} compute credits.
                    Credits are for using the network; they are not node earnings and cannot be withdrawn.
                </p>
            </header>

            {error ? <Notice tone="error">{error}</Notice> : null}
            {params.revoked === "1" ? <Notice>Invite withdrawn. The slot is yours again.</Notice> : null}
            {joined ? (
                <Notice>
                    Welcome in.{" "}
                    {joined === "granted"
                        ? "Your invite bonus is on your balance."
                        : joined === "pending"
                          ? "Confirm your email and the invite bonus lands on your balance."
                          : "This invite does not carry a bonus for your account."}
                </Notice>
            ) : null}

            {accept ? (
                <section className="mb-8 rounded-[1.5rem] border border-[var(--accent)]/40 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">You were invited</h2>
                    <p className="mt-2 text-sm text-[var(--muted)]">
                        Invites are for new accounts (7 days old or less), one per account.
                    </p>
                    <form action="/api/v1/invites/accept" method="post" className="mt-4">
                        <input type="hidden" name="code" value={accept} />
                        <button
                            type="submit"
                            className="rounded-full bg-[var(--accent-strong)] px-5 py-2 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
                        >
                            Accept invite
                        </button>
                    </form>
                </section>
            ) : null}

            {created ? (
                <section className="mb-8 rounded-[1.5rem] border border-emerald-400/30 bg-emerald-400/10 p-6">
                    <h2 className="text-lg font-semibold text-white">Your new invite</h2>
                    <p className="mt-2 text-sm text-emerald-100">Copy it now: it is shown once.</p>
                    <div className="relative mt-4 rounded-lg bg-[var(--panel-strong)] p-4 pr-20 font-mono text-sm text-white">
                        <CopyButton text={inviteUrl(origin, created)} />
                        <p className="break-all">{inviteUrl(origin, created)}</p>
                        <p className="mt-1 text-xs text-[var(--muted)]">code {created}</p>
                    </div>
                </section>
            ) : null}

            {!o ? (
                <Notice tone="error">Invites are unavailable right now. Try again in a minute.</Notice>
            ) : (
                <>
                    <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                        <div className="flex flex-wrap items-baseline justify-between gap-3">
                            <h2 className="text-lg font-semibold text-white">Your invites</h2>
                            <p className="text-sm text-[var(--muted)]">
                                {o.quota.left} of {o.quota.total} left
                            </p>
                        </div>
                        {o.canInvite ? (
                            o.quota.left > 0 ? (
                                <form action="/api/v1/invites" method="post" className="mt-4 flex flex-col gap-3 sm:flex-row">
                                    <input
                                        name="note"
                                        maxLength={200}
                                        placeholder="Who is it for? (only you see this)"
                                        className="min-w-0 flex-1 rounded-full border border-white/15 bg-[var(--panel-strong)] px-4 py-2 text-sm text-white placeholder:text-[var(--muted)]"
                                    />
                                    <button
                                        type="submit"
                                        className="rounded-full bg-[var(--accent-strong)] px-5 py-2 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
                                    >
                                        Create invite
                                    </button>
                                </form>
                            ) : (
                                <p className="mt-4 text-sm text-[var(--muted)]">You have used all your invites.</p>
                            )
                        ) : (
                            <p className="mt-4 text-sm text-[var(--muted)]">
                                Invites unlock once your account is 7 days old
                                {o.unlocksAt ? ` (${o.unlocksAt.slice(0, 10)})` : ""}.
                            </p>
                        )}
                        {o.invites.length ? (
                            <ul className="mt-6 space-y-2">
                                {o.invites.map((i) => (
                                    <li
                                        key={i.id}
                                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-[var(--panel-strong)] px-4 py-3"
                                    >
                                        <div className="min-w-0 flex-1 text-sm">
                                            <p className="truncate text-white">{i.note || "Invite"}</p>
                                            <p className="text-xs text-[var(--muted)]">
                                                {i.status}
                                                {i.status === "used" && i.bonus ? ` · ${BONUS_LABEL[i.bonus] ?? i.bonus}` : ""}
                                                {i.status === "open" && i.expiresAt ? ` · expires ${i.expiresAt.slice(0, 10)}` : ""}
                                            </p>
                                        </div>
                                        {i.status === "open" ? (
                                            <form action={`/api/v1/invites/${encodeURIComponent(i.id)}`} method="post">
                                                <button type="submit" className="text-xs text-[var(--muted)] hover:text-white hover:underline">
                                                    Withdraw
                                                </button>
                                            </form>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </section>

                    <section className="rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                        <h2 className="text-lg font-semibold text-white">Your link</h2>
                        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                            Open and unlimited: we remember who sent each new account here. No bonus by itself.
                        </p>
                        <div className="relative mt-4 rounded-lg bg-[var(--panel-strong)] p-4 pr-20 font-mono text-sm text-white">
                            <CopyButton text={refUrl(origin, o.affiliateCode)} />
                            <p className="break-all">{refUrl(origin, o.affiliateCode)}</p>
                        </div>
                    </section>
                </>
            )}

            <p className="mt-8 text-sm text-[var(--muted)]">
                Have a credit code?{" "}
                <Link href="/settings#credits" className="text-[var(--accent)] hover:underline">
                    Redeem it in settings
                </Link>
                .
            </p>
        </main>
    );
}
