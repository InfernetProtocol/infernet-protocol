"use client";

import { useEffect, useState } from "react";
import { ProfileFields } from "@profullstack/profile/react";

const FIELDS = ["email", "first_name", "last_name", "company_domain", "job_title", "linkedin_url"];
const pick = (p) => Object.fromEntries(FIELDS.map((k) => [k, p?.[k] ?? ""]));

/**
 * Contact details: the shared @profullstack/profile fields, read and saved
 * through /api/v1/me/profile. Private to the account owner.
 */
export default function ContactDetailsForm() {
    const [values, setValues] = useState({});
    const [errors, setErrors] = useState({});
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/v1/me/profile", { credentials: "same-origin" })
            .then((r) => (r.ok ? r.json() : null))
            .then((json) => {
                if (!cancelled && json?.profile) setValues(pick(json.profile));
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    async function onSubmit(e) {
        e.preventDefault();
        setBusy(true);
        setErrors({});
        setMessage(null);
        try {
            const res = await fetch("/api/v1/me/profile", {
                method: "PATCH",
                credentials: "same-origin",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(values)
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                setErrors(json.errors ?? {});
                setMessage({ ok: false, text: json.error ?? "Could not save." });
                return;
            }
            if (json.profile) setValues(pick(json.profile));
            setMessage({ ok: true, text: "Saved." });
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="mt-8 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
            <h2 className="text-lg font-semibold text-white">Contact details</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">Private to you. Never shown on node pages.</p>
            <form onSubmit={onSubmit} className="mt-5 space-y-4">
                <ProfileFields
                    fields={FIELDS}
                    idPrefix="settings-"
                    values={values}
                    onChange={setValues}
                    errors={errors}
                    disabled={loading || busy}
                />
                {message ? (
                    <p className={`text-sm ${message.ok ? "text-[var(--muted)]" : "text-red-400"}`}>{message.text}</p>
                ) : null}
                <button
                    type="submit"
                    disabled={loading || busy}
                    className="rounded-full bg-[var(--accent-strong)] px-6 py-3 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)] disabled:opacity-50"
                >
                    {busy ? "Saving…" : "Save contact details"}
                </button>
            </form>
        </section>
    );
}
