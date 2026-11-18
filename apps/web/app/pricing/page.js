import Link from "next/link";
import { getInferencePricing } from "@/lib/data/billing";
import { getPriceDefaults, marketPriceFor } from "@/lib/data/operator-prices";
import { describePrice } from "@/lib/billing/operator-prices";
import { liveModelNames } from "@/lib/data/chat";
import { FEATURED_MODEL, perChatUsd } from "@/lib/pricing/featured";

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Models & pricing",
    description:
        "Uncensored Qwen3.8 9B on GPU and every model live on Infernet, priced per 1M tokens. OpenAI-compatible API: sign up, top up with crypto or PayPal, create a key, call /v1/chat/completions."
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

const usd = (n) => `$${Number(n).toFixed(Number(n) < 0.01 ? 4 : 2)}`;

async function loadPrices() {
    try {
        const [pricing, defaults, live] = await Promise.all([
            getInferencePricing(),
            getPriceDefaults(),
            liveModelNames().catch(() => [])
        ]);
        const models = [...new Set([...live, ...Object.keys(pricing.models ?? {})])].sort();
        const rows = await Promise.all(models.map(async (model) => {
            const market = await marketPriceFor({ model, defaults }).catch(() => null);
            const d = describePrice({ model, pricing, defaults, dynamic: market });
            return { model, input: d.input_per_m_usd, output: d.output_per_m_usd, fixed: Boolean(d.fixed), live: live.includes(model) };
        }));
        return rows;
    } catch {
        return [];
    }
}

export default async function PricingPage() {
    const rows = await loadPrices();
    const featured = rows.find((r) => r.model === FEATURED_MODEL.id) ?? {
        model: FEATURED_MODEL.id, input: FEATURED_MODEL.input_per_m_usd, output: FEATURED_MODEL.output_per_m_usd, fixed: true, live: false
    };
    const others = rows.filter((r) => r.model !== FEATURED_MODEL.id);
    const chat = perChatUsd(featured);

    return (
        <main className="mx-auto w-full max-w-4xl px-6 py-16 lg:px-10">
            <header className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Models &amp; pricing</p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">Pay per token. No subscription.</h1>
                <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                    Every model on Infernet is served by independent nodes and priced per 1M tokens. Operators keep 95%
                    of what you pay. The API is OpenAI-compatible, so any OpenAI SDK works with a base URL change.
                </p>
            </header>

            <section id="featured" className="mt-10 rounded-2xl border border-[var(--accent)]/40 bg-[var(--panel)] p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--accent)]">Featured</p>
                <h2 className="mt-2 text-3xl font-semibold text-white">{FEATURED_MODEL.label}</h2>
                <p className="mt-2 text-sm text-[var(--muted)]">
                    <code className="text-zinc-200">{FEATURED_MODEL.id}</code> · {FEATURED_MODEL.blurb}
                </p>
                <div className="mt-5 grid gap-4 sm:grid-cols-3">
                    <div><p className="text-xs uppercase tracking-widest text-[var(--muted)]">Input</p><p className="text-2xl font-semibold text-white">{usd(featured.input)}<span className="text-sm text-[var(--muted)]"> / 1M</span></p></div>
                    <div><p className="text-xs uppercase tracking-widest text-[var(--muted)]">Output</p><p className="text-2xl font-semibold text-white">{usd(featured.output)}<span className="text-sm text-[var(--muted)]"> / 1M</span></p></div>
                    <div><p className="text-xs uppercase tracking-widest text-[var(--muted)]">Typical chat</p><p className="text-2xl font-semibold text-white">≈ {usd(chat)}</p><p className="text-xs text-[var(--muted)]">{FEATURED_MODEL.typical.input_tokens.toLocaleString("en-US")} in + {FEATURED_MODEL.typical.output_tokens} out tokens</p></div>
                </div>
                <Code>{`curl https://infernetprotocol.com/v1/chat/completions \\
  -H "Authorization: Bearer $INFERNET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${FEATURED_MODEL.id}",
    "messages": [{"role": "user", "content": "Write a dark limerick about a GPU."}]
  }'`}</Code>
                <Code>{`from openai import OpenAI

client = OpenAI(base_url="https://infernetprotocol.com/v1", api_key="ik_live_...")
r = client.chat.completions.create(
    model="${FEATURED_MODEL.id}",
    messages=[{"role": "user", "content": "Write a dark limerick about a GPU."}],
)
print(r.choices[0].message.content)`}</Code>
            </section>

            <H2 id="start">Start in four steps</H2>
            <ol className="mt-4 list-decimal space-y-3 pl-6 text-base leading-7 text-[var(--muted)]">
                <li><Link href="/auth/signup" className="text-[var(--accent)] hover:underline">Create an account</Link> (email, or Sign in with CoinPay).</li>
                <li>Top up your compute balance from <Link href="/dashboard/billing" className="text-[var(--accent)] hover:underline">Dashboard → Billing</Link> (any coin or PayPal through CoinPay, from $5), or <code>POST /api/v1/billing/topup {"{"}&quot;amount_usd&quot;: 5{"}"}</code>.</li>
                <li>Create an API key on the same page, or <code>POST /api/v1/keys</code>. It starts with <code>ik_live_</code> and is shown once.</li>
                <li>Call <code>/v1/chat/completions</code> with <code>Authorization: Bearer ik_live_...</code>. Each request is charged from your balance at the price below; <code>GET /api/v1/billing/balance</code> shows what is left.</li>
            </ol>

            <H2 id="models">Every model</H2>
            <P>
                Live prices from <a className="text-[var(--accent)] hover:underline" href="/api/v1/pricing">/api/v1/pricing</a>.
                Prices not marked fixed follow supply and demand within a bounded band.
            </P>
            <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
                <table className="w-full min-w-[32rem] text-left text-sm">
                    <thead className="bg-white/5 text-zinc-300">
                        <tr>
                            <th className="px-4 py-2 font-medium">Model</th>
                            <th className="px-4 py-2 font-medium">Input / 1M</th>
                            <th className="px-4 py-2 font-medium">Output / 1M</th>
                            <th className="px-4 py-2 font-medium">Status</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-[var(--muted)]">
                        {[featured, ...others].map((r) => (
                            <tr key={r.model}>
                                <td className="px-4 py-2"><code className="text-zinc-200">{r.model}</code>{r.model === FEATURED_MODEL.id ? <span className="ml-2 text-xs text-[var(--accent)]">{FEATURED_MODEL.label}</span> : null}</td>
                                <td className="px-4 py-2">{usd(r.input)}</td>
                                <td className="px-4 py-2">{usd(r.output)}</td>
                                <td className="px-4 py-2">{r.live ? "live" : "offline"}{r.fixed ? " · fixed" : ""}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </main>
    );
}
