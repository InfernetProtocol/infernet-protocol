import Link from "next/link";
import { DEFAULT_INFERENCE_PRICING } from "@/lib/billing/core";

export const metadata = {
    title: "Paid batch inference",
    description:
        "Run many chat requests as one prepaid batch on Infernet nodes: quote the max cost, hold it from your node earnings or prepaid balance, pay only for what each request produced."
};

function H2({ id, children }) {
    return <h2 id={id} className="scroll-mt-24 pt-10 text-2xl font-semibold tracking-tight text-white">{children}</h2>;
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

const FLOW = `# 1. An API key (sign in first: infernet login, or the site)
infernet keys create --name batch          # prints ik_live_... once
export INFERNET_API_KEY=ik_live_...
BASE=https://infernetprotocol.com

# 2. Fund it: node earnings are used automatically; or top up by CoinPay
curl -sS -X POST $BASE/api/v1/billing/topup -H "Authorization: Bearer $INFERNET_API_KEY" \\
  -H "Content-Type: application/json" -d '{"amount_usd":"5.00"}'      # -> checkout_url
curl -sS $BASE/api/v1/billing/topup/<topup id> -H "Authorization: Bearer $INFERNET_API_KEY"
curl -sS $BASE/api/v1/billing/balance -H "Authorization: Bearer $INFERNET_API_KEY"

# 3. Quote (no spend)
curl -sS -X POST $BASE/api/v1/batches/quote -H "Authorization: Bearer $INFERNET_API_KEY" \\
  -H "Content-Type: application/json" -d '{
    "model":"qwen2.5:7b",
    "items":[{"custom_id":"q1","messages":[{"role":"user","content":"Name three rivers."}],"max_tokens":128}]
  }'                                                     # -> quote_id, total_max_cost_usd

# 4. Submit with a hard cap and an idempotency key
curl -sS -X POST $BASE/api/v1/batches -H "Authorization: Bearer $INFERNET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"quote_id":"<quote id>","max_cost_usd":"0.10","idempotency_key":"run-2026-11-02-a"}'

# 5. Follow it, read results, receipt; cancel stops queued items
curl -sS $BASE/api/v1/batches/<batch id>          -H "Authorization: Bearer $INFERNET_API_KEY"
curl -sS $BASE/api/v1/batches/<batch id>/results  -H "Authorization: Bearer $INFERNET_API_KEY"   # JSONL
curl -sS $BASE/api/v1/batches/<batch id>/receipt  -H "Authorization: Bearer $INFERNET_API_KEY"
curl -sS -X POST $BASE/api/v1/batches/<batch id>/cancel -H "Authorization: Bearer $INFERNET_API_KEY"`;

export default function BatchInferencePage() {
    const models = Object.entries(DEFAULT_INFERENCE_PRICING.models);
    return (
        <main className="mx-auto w-full max-w-4xl px-6 py-16 lg:px-10">
            <header className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Paid batch inference</p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">Many requests, one prepaid batch.</h1>
                <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                    Send up to {DEFAULT_INFERENCE_PRICING.max_items_per_batch} chat requests as one batch. We hold the most it can
                    cost, run each request on the most capable free node that serves the model, charge each one what it
                    produced, and release the rest.
                </p>
            </header>

            <H2 id="price">Pricing</H2>
            <P>
                Per million tokens, by model (the live list: only models a node serves right now are sold). Admins can
                change it; the current numbers are always what a quote returns.
            </P>
            <Code>{models.map(([m, p]) => `${m.padEnd(14)} input $${p.input_per_m_usd}/1M   output $${p.output_per_m_usd}/1M`).join("\n")}</Code>
            <P>
                Token counts are server-side estimates, not the node&apos;s count: input = ceil(characters of the messages / 4),
                output = ceil(characters of the reply / 4), never more than the item&apos;s max_tokens. Each item&apos;s cost is
                rounded up to the next micro-dollar ($0.000001). An item&apos;s max cost is its input estimate plus max_tokens
                of output; failed and cancelled items cost nothing.
            </P>

            <H2 id="funding">What pays for it</H2>
            <P>
                A batch is held from these sources in order (your default is earned, then prepaid, then wallet; change it with
                PUT /api/v1/billing/funding or per batch with funding: earned_first, prepaid_first, earned_only, prepaid_only,
                no_wallet):
            </P>
            <ul className="mt-4 list-disc space-y-2 pl-6 text-[var(--muted)]">
                <li>
                    <b className="text-zinc-200">earned</b>: your confirmed node earnings, if you run nodes. c0mpute node earnings
                    and Infernet node earnings are the same balance (c0mpute has no billing of its own: paid work and payouts run
                    through Infernet and CoinPay). Moving earnings to compute has no fee; what a batch does not spend goes back to
                    your earnings when it finishes. Money moved to compute cannot be withdrawn, and money being paid out cannot be
                    spent: the two are checked under one lock.
                </li>
                <li><b className="text-zinc-200">prepaid</b>: top-ups through a CoinPay checkout (any coin or PayPal), credited only once CoinPay confirms the full amount.</li>
                <li>
                    <b className="text-zinc-200">wallet</b>: when the balances fall short, the submit answers 402 with an x402 offer for the
                    shortfall; send the signed payment back (X-PAYMENT) and the batch is placed in the same request. Or send
                    pay: &quot;checkout&quot; for a CoinPay checkout_url, pay it, and submit again with the same idempotency_key.
                </li>
            </ul>

            <H2 id="flow">The flow, with curl</H2>
            <Code>{FLOW}</Code>
            <P>
                Or with the CLI: <code>infernet batch submit requests.jsonl --model qwen2.5:7b --max-cost 2.50</code> (one
                {" {custom_id, messages, max_tokens} "} per line), <code>infernet batch status|results|receipt|cancel</code>,{" "}
                <code>infernet billing balance|topup</code>. The MCP server (<code>infernet mcp</code>) has batch_quote,
                batch_submit, batch_status and batch_results; only batch_submit spends, and only up to the max_cost_usd you pass.
            </P>

            <H2 id="rules">Rules</H2>
            <ul className="mt-4 list-disc space-y-2 pl-6 text-[var(--muted)]">
                <li>max_cost_usd is required: a batch whose total max cost is above it is refused before anything is held.</li>
                <li>idempotency_key is required: the same key returns the same batch, never a second hold.</li>
                <li>Quotes are valid 15 minutes and never touch your balance.</li>
                <li>At most {DEFAULT_INFERENCE_PRICING.max_in_flight} items of a batch run at once; the rest start as those finish.</li>
                <li>Cancel stops queued items and releases their hold; items already running finish and are charged normally.</li>
                <li>If paid batches are paused, new quotes and submits are refused; running batches finish.</li>
                <li>Nodes are paid from the charge, less the house fee (2% today). See <Link href="/docs" className="text-[var(--accent)] hover:underline">the docs</Link> for running a node.</li>
            </ul>
        </main>
    );
}
