import Link from "next/link";
import { lookupCode } from "@/lib/data/referrals";
import { referralLinks } from "@/lib/referrals/core";
import CopyButton from "@/components/copy-button";
import ReferralTerms from "@/components/referral-terms";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Run an Infernet node",
    description: "Serve open models on the Infernet network and get paid for the jobs your machine runs.",
    robots: { index: false }
};

function Command({ text }) {
    return (
        <div className="relative mt-2 rounded-lg bg-[var(--panel-strong)] p-3 pr-20 font-mono text-xs text-white">
            <CopyButton text={text} />
            <p className="break-all">{text}</p>
        </div>
    );
}

/**
 * /r/<code> — a referral link. Nothing is stored on visit: the code only
 * counts when the node registers with it, so the install commands below
 * carry it into the node's registration.
 */
export default async function ReferralLanding({ params }) {
    const { code: raw } = await params;
    let found = { valid: false, code: null, terms: null };
    try {
        found = await lookupCode(raw);
    } catch (err) {
        console.error("[r] lookup failed", err?.message ?? err);
    }
    const links = found.valid ? referralLinks(found.code) : null;
    return (
        <main className="mx-auto w-full max-w-3xl px-6 py-12 lg:px-10">
            <header className="mb-8 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Run a node</p>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">You were invited to run an Infernet node</h1>
                <p className="text-sm leading-6 text-[var(--muted)]">
                    Your machine serves open models to people and apps on the network, and you are paid for the jobs it runs, minus the
                    published house fee. Being referred changes nothing about what you earn: the referrer&apos;s share comes out of the
                    house fee.
                </p>
            </header>

            {found.valid ? (
                <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">Use the network</h2>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                        Create an account and use open models in <Link className="underline" href="/chat">chat</Link> or through the API. You
                        pay the normal price; if you sign up from this link, the person who invited you gets a share of the house fee on what
                        you spend, out of the house&apos;s cut.
                    </p>
                    <p className="mt-3">
                        <Link className="underline" href="/auth/signup">Create an account</Link>
                    </p>
                </section>
            ) : null}

            {found.valid ? (
                <section className="mb-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                    <h2 className="text-lg font-semibold text-white">Install</h2>
                    <p className="mt-1 text-sm text-[var(--muted)]">Linux or macOS. The code {found.code} is applied when the node registers.</p>
                    <Command text={links.install.infernet} />
                    <p className="mt-4 text-sm text-[var(--muted)]">Already have the CLI? Register with the code:</p>
                    <Command text={links.install.infernet_register} />
                    <p className="mt-4 text-sm text-[var(--muted)]">
                        Or run a <a className="underline" href={links.links.c0mpute}>c0mpute node</a>:
                    </p>
                    <Command text={links.install.c0mpute} />
                </section>
            ) : (
                <section className="mb-8 rounded-[1.5rem] border border-red-400/30 bg-red-400/10 p-6 text-sm text-red-100">
                    That referral code was not found. You can still <Link className="underline" href="/getting-started">run a node</Link>.
                </section>
            )}

            {found.terms ? <ReferralTerms terms={found.terms} /> : null}
        </main>
    );
}
