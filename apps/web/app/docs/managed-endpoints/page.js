import Link from "next/link";
import { priceList } from "@/lib/reservations/pricing";

export const metadata = {
    title: "Managed endpoints for resellers",
    description:
        "Reserve one identified operator serving exact models for whole hours: per-key API keys, agreed rate and concurrency limits, included tokens, a per-minute availability record, and post-paid billing on compliant hours only."
};

function H2({ id, children }) {
    return (
        <h2 id={id} className="scroll-mt-24 pt-10 text-2xl font-semibold tracking-tight text-white">
            {children}
        </h2>
    );
}

function P({ children }) {
    return <p className="mt-4 text-base leading-7 text-[var(--muted)]">{children}</p>;
}

function Code({ children }) {
    return (
        <pre className="mt-4 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-4 text-sm leading-6 text-zinc-200">
            <code>{children}</code>
        </pre>
    );
}

function Table({ columns, rows }) {
    return (
        <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="bg-white/5 text-zinc-300">
                    <tr>{columns.map((c) => <th key={c} className="px-4 py-2 font-medium">{c}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-[var(--muted)]">
                    {rows.map((r) => (
                        <tr key={r[0]}>{r.map((cell, i) => <td key={i} className="px-4 py-2 align-top">{i === 0 ? <code className="text-zinc-200">{cell}</code> : cell}</td>)}</tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default function ManagedEndpointsPage() {
    return (
        <main className="mx-auto w-full max-w-4xl px-6 py-16 lg:px-10">
            <header className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Managed endpoints</p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                    One operator, exact models, reserved by the hour.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                    For resellers who manage their own customers and billing. Instead of access to a pool of
                    nodes, you get a reservation: a named operator serving the exact model ids you agreed, from a
                    whole-hour start for a fixed number of hours, under limits you agreed. You hand out API keys;
                    we keep a minute-by-minute record of availability that you can check yourself, and only
                    compliant hours are billable.
                </p>
            </header>

            <H2 id="what">What a reservation fixes</H2>
            <Table
                columns={["Term", "Meaning"]}
                rows={[
                    ["operator", "The identified operator serving the reservation. Requests never go to anyone else."],
                    ["target", "Either one registered Infernet node, or the operator's own OpenAI-compatible endpoint."],
                    ["models", "Exact model ids. A request for any other model is refused (400 model_not_reserved)."],
                    ["start_at + hours", "Starts on a whole UTC hour; each hour is 60 continuous minutes. Keys only work inside the window."],
                    ["included_tokens", "Prompt + completion tokens included across the reservation. When used up: 429 token_allowance_exhausted."],
                    ["per_key_rps / per_key_concurrency", "Limits on each key you issue."],
                    ["shared_rps / shared_concurrency", "Limits across all keys on the reservation together."],
                    ["required_minutes_per_hour", "How many of an hour's 60 minutes must be confirmed for that hour to be compliant. 60 means every minute."],
                    ["gpu_class", "The GPU tier the reservation is priced from (see Pricing). Sets price_per_hour and setup_fee."],
                    ["price_per_hour + currency", "Post-paid price per compliant hour. Defaults to the gpu_class list price; never below it."],
                    ["setup_fee", "Charged once, when the reservation delivers its first compliant hour. Covers warming the GPU."]
                ]}
            />
            <H2 id="pricing">Pricing</H2>
            <P>
                Priced by the dedicated GPU your models need, per compliant hour, post-paid. Non-compliant hours
                cost nothing. Machine-readable at <code>GET /api/v1/reservations/pricing</code>.
            </P>
            <Table
                columns={["gpu_class", "GPU", "Fits", "Per hour", "Setup fee"]}
                rows={priceList().tiers.map((t) => [
                    t.gpu_class, t.label, t.fits, `$${t.price_per_hour.toFixed(2)}`, `$${t.setup_fee.toFixed(2)}`
                ])}
            />
            <P>
                The setup fee is {priceList().setup_fee}. The operator, the models and the SLA threshold are agreed
                per reservation before it is booked. Write to{" "}
                <a className="text-[var(--accent)] hover:underline" href="mailto:hello@infernetprotocol.com">hello@infernetprotocol.com</a>.
            </P>

            <H2 id="keys">Keys for your customers</H2>
            <P>
                Each reservation can have any number of API keys (prefix <code>ifr_res_</code>). You issue and revoke
                them yourself with the reservation&apos;s buyer token (see below), one per customer if you like; the
                shared limits still cap all of them together. A key is shown once. Revocation takes effect on the
                next request. Keys work with any OpenAI client:
            </P>
            <Code>{`export OPENAI_BASE_URL=https://infernetprotocol.com/v1
export OPENAI_API_KEY=ifr_res_...

curl -sS $OPENAI_BASE_URL/models -H "Authorization: Bearer $OPENAI_API_KEY"   # only the reserved models

curl -sS $OPENAI_BASE_URL/chat/completions \\
  -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model":"<reserved model id>","messages":[{"role":"user","content":"Classify: ..."}]}'`}</Code>

            <H2 id="limits">When a limit is hit</H2>
            <P>Refusals are HTTP 429 with headers that say which limit and when to retry:</P>
            <Table
                columns={["Header", "Value"]}
                rows={[
                    ["X-Infernet-Limit-Type", "rps, concurrency or tokens"],
                    ["X-Infernet-Limit-Scope", "key (this key's limit) or shared (the reservation's)"],
                    ["X-RateLimit-Limit / X-RateLimit-Remaining", "the limit that was hit and what is left"],
                    ["Retry-After", "seconds"],
                    ["X-Infernet-Reservation", "the reservation id"]
                ]}
            />
            <P>
                Successful responses carry <code>X-RateLimit-Remaining-Requests</code>,{" "}
                <code>X-Infernet-Shared-Remaining-Requests</code> and the concurrency limits. Every refusal is
                counted in the report as a limit hit.
            </P>

            <H2 id="availability">How availability is proven</H2>
            <P>
                Every minute of the window, whether or not anyone sends a request, the control plane probes the
                pinned target and stores one record for that minute:
            </P>
            <ul className="mt-4 list-disc space-y-2 pl-6 text-[var(--muted)]">
                <li>
                    <strong className="text-zinc-200">Operator endpoint:</strong> <code>GET /models</code> must list
                    every reserved model id. With completion probes on, a one-token completion on each model must
                    also succeed and report that model.
                </li>
                <li>
                    <strong className="text-zinc-200">Infernet node:</strong> the node&apos;s signed heartbeat must be
                    under 90 seconds old, report itself available, and list every reserved model as served.
                </li>
            </ul>
            <P>
                A minute is <em>confirmed</em> when its probe succeeded and no real request failed upstream in that
                minute. A minute with no record (for example if the prober itself did not run) is{" "}
                <em>unconfirmed</em>; it is never assumed to be fine. An hour is <em>compliant</em> when its confirmed
                minutes reach <code>required_minutes_per_hour</code>. Hours with no requests are judged the same way,
                so an idle reserved hour that stayed up is compliant.
            </P>

            <H2 id="report">The report you can check</H2>
            <P>
                Each reservation comes with a buyer token (prefix <code>ifr_buy_</code>) scoped to that one
                reservation. With it you can issue and revoke keys, and read the per-hour verdicts, the failures
                behind them, every per-minute record, and usage (requests, tokens, limit hits). It cannot change the
                reservation&apos;s terms or see anything else:
            </P>
            <Code>{`curl -sS https://infernetprotocol.com/api/v1/reservations/<id>/report?minutes=1 \\
  -H "X-Buyer-Token: ifr_buy_..."

curl -sS https://infernetprotocol.com/api/v1/reservations/<id>/invoice \\
  -H "X-Buyer-Token: ifr_buy_..."`}</Code>
            <P>Or from the CLI:</P>
            <Code>{`INFERNET_BUYER_TOKEN=ifr_buy_... infernet reservation key-issue <id> --label customer-a
INFERNET_BUYER_TOKEN=ifr_buy_... infernet reservation report <id>
INFERNET_BUYER_TOKEN=ifr_buy_... infernet reservation invoice <id>
INFERNET_BUYER_TOKEN=ifr_buy_... infernet reservation watch <id>    # live view`}</Code>

            <H2 id="billing">Post-paid billing</H2>
            <P>
                Nothing is charged up front and nothing is charged by this system. The invoice view lists each
                reserved hour with its status and computes <code>amount_due = compliant hours × price_per_hour + setup_fee</code> (the setup fee only once an hour is compliant).
                Non-compliant and cancelled hours are owed nothing. The figure is <code>final</code> only once every
                hour has ended. You verify it against the report, then pay as agreed.
            </P>

            <H2 id="api">API, CLI and MCP</H2>
            <Table
                columns={["Endpoint", "Auth", "What"]}
                rows={[
                    ["POST /api/v1/reservations", "admin", "Book a reservation; returns the buyer token once"],
                    ["GET /api/v1/reservations", "admin", "List reservations"],
                    ["GET|PATCH /api/v1/reservations/:id", "admin (GET: or buyer token)", "Show; set price, notes, or cancel"],
                    ["GET|POST /api/v1/reservations/:id/keys", "admin or buyer token", "List or issue keys"],
                    ["DELETE /api/v1/reservations/:id/keys/:keyId", "admin or buyer token", "Revoke a key"],
                    ["GET /api/v1/reservations/:id/report", "admin or buyer token", "Per-hour compliance + usage (?minutes=1 for raw records)"],
                    ["GET /api/v1/reservations/:id/invoice", "admin or buyer token", "Post-paid invoice data"],
                    ["POST /api/v1/reservations/:id/buyer-token", "admin", "Rotate the buyer token"],
                    ["POST /v1/chat/completions, GET /v1/models", "reservation key", "Inference on the pinned target"]
                ]}
            />
            <P>
                The same operations are in the CLI as <code>infernet reservation …</code> (run{" "}
                <code>infernet reservation --help</code>) and as MCP tools via <code>infernet mcp</code>, e.g.{" "}
                <code>claude mcp add infernet -- infernet mcp</code>.
            </P>

            <p className="mt-12 text-sm text-[var(--muted)]">
                Back to the <Link href="/docs" className="text-[var(--accent)] hover:underline">documentation</Link>.
            </p>
        </main>
    );
}
