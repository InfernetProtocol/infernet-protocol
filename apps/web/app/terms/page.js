import Link from "next/link";

export const metadata = {
    title: "Terms of Service",
    description:
        "Terms of Service for Infernet Protocol — the rules of the road for using infernetprotocol.com and the Infernet network."
};

const LAST_UPDATED = "2026-04-28";

export default function TermsPage() {
    return (
        <>
            <main className="mx-auto w-full max-w-3xl px-6 py-16 lg:px-10">
                <header className="mb-10 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
                        Legal
                    </p>
                    <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                        Terms of Service
                    </h1>
                    <p className="text-sm text-[var(--muted)]">Last updated: {LAST_UPDATED}</p>
                </header>

                <div className="prose-block space-y-6 text-base leading-7 text-[var(--muted)]">
                    <Section title="1. What Infernet is">
                        <p>
                            Infernet Protocol (&ldquo;Infernet&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) is an
                            open-source peer-to-peer GPU compute marketplace. <code>infernetprotocol.com</code>{" "}
                            is one (the default) control plane. Operators run GPU nodes; clients submit
                            inference and training jobs; payments settle in cryptocurrency between operator
                            and client.
                        </p>
                        <p>
                            By using <code>infernetprotocol.com</code>, the <code>infernet</code> CLI, or
                            participating in the network in any role, you agree to these Terms.
                        </p>
                    </Section>

                    <Section title="2. Eligibility & accounts">
                        <p>
                            You must be at least 18 years old and legally able to enter into a contract in
                            your jurisdiction. You are responsible for the security of your account
                            credentials, your CLI bearer tokens, and any keys associated with your operator
                            identity (Nostr keypair, payout wallets).
                        </p>
                    </Section>

                    <Section title="3. Acceptable use">
                        <p>You may not use the network to:</p>
                        <ul className="ml-5 list-disc space-y-1">
                            <li>Run inference or training that violates applicable law in your jurisdiction or the operator&apos;s.</li>
                            <li>Generate CSAM, non-consensual intimate imagery, or content designed to defraud or impersonate.</li>
                            <li>Distribute malware, exploit material, or commands to attack third-party systems.</li>
                            <li>Circumvent rate limits, abuse free tiers, or scrape the public site beyond its documented APIs.</li>
                            <li>Run hardware that materially misrepresents its capabilities to clients.</li>
                        </ul>
                        <p>
                            Operators set their own model and content policies. Clients should expect a
                            given operator may decline a job for any reason. We may suspend access to{" "}
                            <code>infernetprotocol.com</code> for violations of these terms; the underlying
                            protocol is permissionless and not under our control.
                        </p>
                    </Section>

                    <Section title="4. Payments">
                        <p>
                            Payments flow directly between client and operator in cryptocurrency, settled
                            via the configured payment processor (today, CoinPayPortal). Wallets are
                            non-custodial except where Lightning balances are held. We are not a bank, not
                            a money transmitter on your behalf, and do not act as an escrow.
                        </p>
                        <p>
                            We take a 10% house fee on paid jobs. Pricing displayed for any job is the price
                            the client agrees to pay; the operator receives 90% of the agreed amount, less
                            the payment processor&apos;s fee.
                        </p>
                    </Section>

                    <Section title="5. No warranty">
                        <p>
                            The software, control plane, and network are provided <strong>&ldquo;as is&rdquo;</strong>{" "}
                            without warranties of any kind, express or implied, including merchantability,
                            fitness for a particular purpose, and non-infringement. Output produced by
                            third-party operators is their responsibility, not ours.
                        </p>
                    </Section>

                    <Section title="6. Limitation of liability">
                        <p>
                            To the maximum extent permitted by law, our aggregate liability arising out of
                            or relating to these Terms or the service is limited to the greater of (a)
                            US$100 or (b) the fees we received from you in the twelve months preceding the
                            claim. We are not liable for indirect, incidental, special, consequential, or
                            punitive damages, including lost profits, lost revenue, or lost data.
                        </p>
                    </Section>

                    <Section title="7. Open-source license">
                        <p>
                            The Infernet codebase is released under the MIT license. Self-hosting your own
                            control plane is encouraged and explicitly supported — see the{" "}
                            <Link href="/docs#self-host" className="text-[var(--accent)] hover:underline">
                                self-hosting docs
                            </Link>
                            . These Terms apply to <code>infernetprotocol.com</code>; self-hosted
                            deployments set their own terms.
                        </p>
                    </Section>

                    <Section title="8. Changes">
                        <p>
                            We may update these Terms over time. Material changes will be flagged in the
                            page footer and at the top of this document. Continued use of the service after
                            an update constitutes acceptance.
                        </p>
                    </Section>

                    <Section title="9. Contact">
                        <p>
                            Questions:{" "}
                            <a href="mailto:hello@infernetprotocol.com" className="text-[var(--accent)] hover:underline">
                                hello@infernetprotocol.com
                            </a>
                            .
                        </p>
                    </Section>
                </div>
            </main>
        </>
    );
}

function Section({ title, children }) {
    return (
        <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">{title}</h2>
            {children}
        </section>
    );
}
