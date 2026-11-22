import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { getReferralOverview } from "@/lib/data/referrals";
import { referralLinks } from "@/lib/referrals/core";
import { fmtUsdPrecise } from "@/lib/earnings/core";
import { publicOrigin } from "@/lib/credits/core";
import CopyButton from "@/components/copy-button";
import ReferralTerms from "@/components/referral-terms";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Refer a node — Infernet",
    description: "Earn a share of the house fee on the nodes you bring to Infernet and c0mpute.",
    robots: { index: false }
};

const NOTICES = {
    created: "Your referral link is ready.",
    address_saved: "Payout address saved.",
    payout_requested: "Payout requested. It is sent once it is approved.",
    payout_sent: "Payout sent through CoinPay."
};

const STATUS = { pending: "pending payment", pending_approval: "pending review", confirmed: "confirmed", void: "void" };

function Notice({ tone = "ok", children }) {
    const cls = tone === "ok" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : "border-red-400/30 bg-red-400/10 text-red-200";
    return <div className={`mb-6 rounded-lg border p-3 text-sm ${cls}`}>{children}</div>;
}

function Stat({ label, value }) {
    return (
        <div className="rounded-xl border border-white/10 bg-[var(--panel-strong)] p-4">
            <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p>
            <p className="mt-1 text-xl font-semibold text-white">{value}</p>
        </div>
    );
}

function Command({ text }) {
    return (
        <div className="relative mt-2 rounded-lg bg-[var(--panel-strong)] p-3 pr-20 font-mono text-xs text-white">
            <CopyButton text={text} />
            <p className="break-all">{text}</p>
        </div>
    );
}

const input = "w-full rounded-lg border border-white/10 bg-[var(--panel-strong)] px-3 py-2 text-sm text-white";
const button = "rounded-full bg-[var(--accent-strong)] px-5 py-2 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]";

/**
 * /refer — "Refer a node": your referral link, the install commands that
 * carry it, the nodes you referred, commissions (pending / confirmed / paid)
 * and payouts. Commissions come out of the house fee, not the operator's
 * earnings; see the terms at the bottom.
 */
export default async function ReferPage({ searchParams }) {
    const user = await getCurrentUser();
    if (!user) redirect("/auth/login?next=/refer");
    const params = (await searchParams) ?? {};
    const origin = publicOrigin({ headers: await headers() });

    let o = null;
    try {
        o = await getReferralOverview(user.id);
    } catch (err) {
        console.error("[refer] overview failed", err?.message ?? err);
    }
    const links = o?.has_code ? referralLinks(o.code, { infernetOrigin: origin }) : null;

    return (
        <main className="mx-auto w-full max-w-3xl px-6 py-12 lg:px-10">
            <header className="mb-8 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Refer a node</p>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Bring a node, share the house fee</h1>
                <p className="text-sm leading-6 text-[var(--muted)]">
                    When a node you referred serves paid jobs on Infernet or c0mpute, you get {o?.terms?.commission_pct_of_house_fee ?? 5}% of
                    the house fee on each one. It comes out of the house's cut, so the operator keeps all of their earnings.
                </p>
            </header>

            {typeof params.error === "string" ? <Notice tone="error">{params.error}</Notice> : null}
            {typeof params.ok === "string" && NOTICES[params.ok] ? <Notice>{NOTICES[params.ok]}</Notice> : null}

            {!o ? (
                <Notice tone="error">Referrals are unavailable right now. Try again in a minute.</Notice>
            ) : !o.has_code ? (
                <section className="mb-8 rounded-[1.5rem] border border-[var(--accent)]/40 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">Get your referral link</h2>
                    <p className="mt-2 text-sm text-[var(--muted)]">One link per account, for both infernetprotocol.com and c0mpute.com.</p>
                    <form action="/api/v1/referrals" method="post" className="mt-4">
                        <input type="hidden" name="create" value="1" />
                        <button type="submit" className={button}>Create my referral link</button>
                    </form>
                </section>
            ) : (
                <>
                    <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                        <h2 className="text-lg font-semibold text-white">Your link</h2>
                        <p className="mt-1 text-sm text-[var(--muted)]">
                            Code <span className="font-mono text-white">{o.code}</span>. Your commission term: {o.terms?.term?.label}.
                        </p>
                        <Command text={links.links.infernet} />
                        <Command text={links.links.c0mpute} />
                        <h3 className="mt-6 text-sm font-semibold text-white">Install commands that carry your code</h3>
                        <p className="mt-1 text-xs text-[var(--muted)]">
                            A node is credited to you when it registers with your code, before its first paid job. Send operators one of these:
                        </p>
                        <Command text={links.install.infernet} />
                        <Command text={links.install.infernet_register} />
                        <Command text={links.install.c0mpute} />
                        <Command text={links.install.c0mpute_register} />
                    </section>

                    <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <Stat label="Referred nodes" value={o.referred_nodes} />
                        <Stat label="Active (7 days)" value={o.active_nodes_7d} />
                        <Stat label="Pending" value={fmtUsdPrecise(o.balance.pending_usd)} />
                        <Stat label="Available" value={fmtUsdPrecise(o.balance.available_usd)} />
                        <Stat label="Confirmed" value={fmtUsdPrecise(o.balance.confirmed_usd)} />
                        <Stat label="Requested" value={fmtUsdPrecise(o.balance.requested_usd)} />
                        <Stat label="Paid out" value={fmtUsdPrecise(o.balance.paid_usd)} />
                        <Stat label="Commissions" value={o.balance.commissions} />
                    </section>

                    <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                        <h2 className="text-lg font-semibold text-white">Payouts</h2>
                        <p className="mt-1 text-sm text-[var(--muted)]">
                            {o.payout_address
                                ? `Paid to ${o.payout_address.coin} on ${o.payout_address.network}: ${o.payout_address.address}`
                                : "Set where your commissions are paid before requesting a payout."}
                        </p>
                        <form action="/api/v1/referrals/address" method="post" className="mt-4 grid gap-3 sm:grid-cols-[6rem_8rem_1fr_auto]">
                            <input name="coin" placeholder="USDC" defaultValue={o.payout_address?.coin ?? "USDC"} className={input} required />
                            <input name="network" placeholder="polygon" defaultValue={o.payout_address?.network ?? "polygon"} className={input} required />
                            <input name="address" placeholder="0x..." defaultValue={o.payout_address?.address ?? ""} className={input} required />
                            <button type="submit" className={button}>Save</button>
                        </form>
                        <form action="/api/v1/referrals/payout" method="post" className="mt-4 flex flex-wrap items-center gap-3">
                            <input name="amount_usd" placeholder={`all (${fmtUsdPrecise(o.balance.available_usd)})`} className={`${input} max-w-[12rem]`} />
                            <button type="submit" className={button} disabled={!o.payout_address}>Request payout</button>
                        </form>
                        {o.payouts.length ? (
                            <ul className="mt-4 space-y-1 text-xs text-[var(--muted)]">
                                {o.payouts.map((p) => (
                                    <li key={p.id}>
                                        {new Date(p.created_at).toISOString().slice(0, 10)} · {fmtUsdPrecise(p.amount_usd)} {p.coin} · {p.status}
                                        {p.tx_hash ? ` · ${p.tx_hash.slice(0, 12)}…` : ""}
                                        {p.error ? ` · ${p.error}` : ""}
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </section>

                    <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                        <h2 className="text-lg font-semibold text-white">Referred nodes</h2>
                        {o.nodes.length ? (
                            <ul className="mt-3 space-y-1 text-sm text-[var(--muted)]">
                                {o.nodes.map((n) => (
                                    <li key={n.node + n.attributed_at}>
                                        <span className="font-mono text-white">{n.node}</span> · joined {n.attributed_at.slice(0, 10)}
                                        {n.first_paid_job_at ? ` · first paid job ${n.first_paid_job_at.slice(0, 10)}` : " · no paid jobs yet"}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="mt-2 text-sm text-[var(--muted)]">None yet.</p>
                        )}
                        {o.recent.length ? (
                            <>
                                <h3 className="mt-6 text-sm font-semibold text-white">Recent commissions</h3>
                                <table className="mt-2 w-full text-left text-xs text-[var(--muted)]">
                                    <thead>
                                        <tr><th className="py-1">When</th><th>Node</th><th>House fee</th><th>Commission</th><th>Status</th></tr>
                                    </thead>
                                    <tbody>
                                        {o.recent.map((c) => (
                                            <tr key={c.id}>
                                                <td className="py-1">{c.earned_at.slice(0, 16).replace("T", " ")}</td>
                                                <td className="font-mono">{c.node}</td>
                                                <td>{fmtUsdPrecise(c.fee_usd)}</td>
                                                <td className="text-white">{fmtUsdPrecise(c.amount_usd)}</td>
                                                <td>{STATUS[c.status] ?? c.status}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </>
                        ) : null}
                    </section>
                </>
            )}

            {o ? <ReferralTerms terms={o.terms} /> : null}
        </main>
    );
}
