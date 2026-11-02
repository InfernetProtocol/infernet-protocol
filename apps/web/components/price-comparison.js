import Link from "next/link";
import { getInferencePricing } from "@/lib/data/billing";
import { comparisonRows, EXAMPLE_JOB, formatUsd, REFERENCE_PRICES } from "@/lib/pricing/comparison";

/**
 * Homepage price comparison. Our prices are read from the live pricing
 * settings (the same numbers /api/v1/batches charges); frontier prices are
 * dated list prices with their official sources. Different model classes:
 * the copy says so next to the numbers.
 */
export default async function PriceComparison() {
    const pricing = await getInferencePricing();
    const rows = comparisonRows(pricing);
    const checked = REFERENCE_PRICES.map((r) => r.checked).sort().at(-1);
    const usd = (v) => `$${Number(v).toFixed(2).replace(/\.00$/, "")}`; // $0.05, $4, $20

    return (
        <section id="pricing" className="border-b border-white/10">
            <div className="mx-auto max-w-6xl px-6 py-20 lg:px-10">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
                    Price per 1M tokens
                </p>
                <h2 className="mt-4 max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
                    Routine batch work at a fraction of frontier API prices.
                </h2>
                <p className="mt-6 max-w-3xl text-base leading-7 text-[var(--muted)]">
                    These are <strong className="text-white">different classes of model</strong>. Claude Opus 5.5 and
                    GPT-6 Astra are frontier models and far more capable. Infernet runs small open models (Qwen 2.5) on
                    community GPUs and CPUs: right for extraction, classification, tagging and summarizing at volume,
                    not for hard reasoning or long agentic work. If a small model passes your eval, this is what the
                    same job costs.
                </p>

                <div className="mt-10 overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full min-w-[640px] text-left text-sm">
                        <thead className="bg-white/[0.03] text-[var(--muted)]">
                            <tr>
                                <th className="px-4 py-3 font-medium">Model</th>
                                <th className="px-4 py-3 font-medium">Input / 1M</th>
                                <th className="px-4 py-3 font-medium">Output / 1M</th>
                                <th className="px-4 py-3 font-medium">Example job*</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.id} className={`border-t border-white/5 ${r.ours ? "bg-[var(--accent)]/[0.06]" : ""}`}>
                                    <td className="px-4 py-3">
                                        <div className="font-medium text-white">{r.name}</div>
                                        <div className="text-xs text-[var(--muted)]">
                                            {r.ours ? r.vendor : (
                                                <a href={r.source} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                                    {r.vendor}, {r.note}
                                                </a>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-white">{usd(r.input_per_m_usd)}</td>
                                    <td className="px-4 py-3 text-white">{usd(r.output_per_m_usd)}</td>
                                    <td className={`px-4 py-3 font-semibold ${r.ours ? "text-[var(--accent)]" : "text-white"}`}>{formatUsd(r.job_usd)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="mt-4 max-w-3xl space-y-2 text-xs leading-6 text-[var(--muted)]">
                    <p>
                        * {EXAMPLE_JOB.label}: {(EXAMPLE_JOB.input_tokens / 1e6).toLocaleString("en-US")}M input and{" "}
                        {(EXAMPLE_JOB.output_tokens / 1e6).toLocaleString("en-US")}M output tokens at each model&apos;s list price,
                        before caching, batch discounts or long-context surcharges. Infernet token counts are server-side
                        estimates (characters / 4) and every batch has a hard spending cap you set.
                    </p>
                    <p>
                        Frontier prices are the vendors&apos; published standard rates, checked {checked}; follow the links for
                        current rates. Infernet prices are the live rates the batch API charges; node operators keep 98%.
                    </p>
                </div>

                <div className="mt-8 flex flex-wrap gap-3">
                    <Link href="/docs/batch-inference" className="rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-black hover:opacity-90">
                        Run a paid batch
                    </Link>
                    <Link href="/dashboard/billing" className="rounded-full border border-white/20 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/5">
                        Get an API key
                    </Link>
                </div>
            </div>
        </section>
    );
}
