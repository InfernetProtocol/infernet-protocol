import { contactGuard } from "@/lib/contact-guard";

export const metadata = {
    title: "Contact",
    description:
        "Get in touch with the Infernet Protocol team. Operator support, partnership inquiries, security disclosures."
};

// The form carries a token minted at render time, so the page must not be
// cached — a stale page would hand every visitor the same expired token.
export const dynamic = "force-dynamic";

export default async function ContactPage({ searchParams }) {
    const params = (await searchParams) ?? {};
    const sent = params.sent === "1";
    const error = typeof params.error === "string" ? params.error : null;
    // Links can prefill the subject (the gallery's "Submit your build" sends
    // ?subject=Gallery submission).
    const subject = typeof params.subject === "string" ? params.subject.slice(0, 120) : undefined;

    const token = contactGuard ? await contactGuard.issue() : null;
    const guardFields = token ? contactGuard.fields(token) : null;

    return (
        <>
            <main className="mx-auto w-full max-w-3xl px-6 py-16 lg:px-10">
                <header className="mb-10 space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
                        Contact
                    </p>
                    <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                        Get in touch.
                    </h1>
                    <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                        Operator support, partnership inquiries, security disclosures — drop a note and
                        we&apos;ll reply from{" "}
                        <a
                            href="mailto:hello@infernetprotocol.com"
                            className="text-[var(--accent)] hover:underline"
                        >
                            hello@infernetprotocol.com
                        </a>
                        .
                    </p>
                </header>

                {sent ? (
                    <div className="mb-8 rounded-[1rem] border border-emerald-400/30 bg-emerald-400/10 p-5 text-sm text-emerald-200">
                        Thanks — message sent. We&apos;ll reply to the address you provided.
                    </div>
                ) : null}
                {error ? (
                    <div className="mb-8 rounded-[1rem] border border-red-400/30 bg-red-400/10 p-5 text-sm text-red-200">
                        {error}
                    </div>
                ) : null}

                <form
                    action="/api/contact"
                    method="post"
                    className="space-y-5 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-8 backdrop-blur"
                >
                    <Field name="name" label="Your name" required autoComplete="name" />
                    <Field name="email" label="Email" type="email" required autoComplete="email" />
                    <Field name="subject" label="Subject" required defaultValue={subject} />
                    <label className="block">
                        <span className="block text-xs font-medium uppercase tracking-[0.2em] text-[var(--muted)]">
                            Message
                        </span>
                        <textarea
                            name="message"
                            required
                            minLength={10}
                            rows={8}
                            className="mt-2 block w-full rounded-lg border border-white/10 bg-[var(--panel-strong)] px-4 py-3 text-sm text-white outline-none ring-0 placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30"
                        />
                    </label>
                    {guardFields ? (
                        <>
                            {/* Proof that this form was actually rendered. Without it
                                a bot can POST straight at /api/contact and never see
                                the honeypot below at all — which is how the spam that
                                prompted this got through. */}
                            <input
                                type="hidden"
                                name={guardFields.token.name}
                                value={guardFields.token.value}
                            />
                            {/* Honeypot. Positioned off-canvas rather than
                                display:none — some bots skip fields they can tell are
                                not rendered, and this one should look real to them. */}
                            <div
                                aria-hidden="true"
                                className="absolute -left-[9999px] h-px w-px overflow-hidden"
                            >
                                <label>
                                    Website
                                    <input
                                        type="text"
                                        name={guardFields.honeypot.name}
                                        tabIndex={-1}
                                        autoComplete="off"
                                    />
                                </label>
                            </div>
                        </>
                    ) : null}
                    <button
                        type="submit"
                        className="w-full rounded-full bg-[var(--accent-strong)] px-6 py-3 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
                    >
                        Send message
                    </button>
                </form>
            </main>
        </>
    );
}

function Field({ name, label, type = "text", required = false, autoComplete, defaultValue }) {
    return (
        <label className="block">
            <span className="block text-xs font-medium uppercase tracking-[0.2em] text-[var(--muted)]">
                {label}
            </span>
            <input
                name={name}
                type={type}
                required={required}
                autoComplete={autoComplete}
                defaultValue={defaultValue}
                className="mt-2 block w-full rounded-lg border border-white/10 bg-[var(--panel-strong)] px-4 py-3 text-sm text-white outline-none ring-0 placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30"
            />
        </label>
    );
}
