/**
 * Homepage price comparison: Infernet's paid batch prices next to frontier
 * API list prices. Pure, so it is unit-tested.
 *
 * Reference prices are dated claims (PRD claims register): each carries the
 * date it was checked and the official source. Re-check before changing any
 * number; if a reference goes stale, update `checked` with it.
 *
 * Honesty rule: these are different classes of model. Infernet sells small
 * open models for routine batch work; the frontier models are far more
 * capable. The page must say so next to the numbers, never imply parity.
 */

export const REFERENCE_PRICES = Object.freeze([
    {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        vendor: "Anthropic",
        input_per_m_usd: 4,
        output_per_m_usd: 20,
        checked: "2026-11-02",
        source: "https://claude.com/pricing",
        note: "standard API rate"
    },
    {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        vendor: "OpenAI",
        input_per_m_usd: 10,
        output_per_m_usd: 50,
        checked: "2026-11-02",
        source: "https://developers.openai.com/api/docs/pricing",
        note: "standard tier, up to 272K input tokens ($20 / $75 above)"
    }
]);

/** Display order for our own models (largest first); others follow alphabetically. */
const OUR_ORDER = ["qwen2.5:7b", "qwen2.5:1.5b", "qwen2.5:0.5b"];

/** The worked example: one batch job priced on every model. */
export const EXAMPLE_JOB = Object.freeze({
    label: "10,000 documents, ~1,000 tokens in and ~200 tokens out each",
    input_tokens: 10_000 * 1_000,
    output_tokens: 10_000 * 200
});

/** Cost of `job` at the given per-1M prices, in USD (not rounded). */
export function jobCostUsd({ input_per_m_usd, output_per_m_usd }, job = EXAMPLE_JOB) {
    return (job.input_tokens / 1e6) * Number(input_per_m_usd) + (job.output_tokens / 1e6) * Number(output_per_m_usd);
}

/** "$0.90", "$80", "$0.000123": enough digits to be honest about tiny numbers. */
export function formatUsd(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    if (n === 0) return "$0";
    if (n >= 100) return `$${Math.round(n).toLocaleString("en-US")}`;
    if (n >= 1) return `$${n.toFixed(2).replace(/\.00$/, "")}`;
    if (n >= 0.01) return `$${n.toFixed(2)}`;
    return `$${n.toPrecision(2)}`;
}

/**
 * Rows for the table: our sellable models (from live pricing) then the
 * references, each with the example job's cost. Returns [] for ours when
 * paid batch is switched off, so the page never advertises a price we
 * would refuse to charge.
 */
export function comparisonRows(pricing, refs = REFERENCE_PRICES, job = EXAMPLE_JOB) {
    const ours = pricing?.enabled ? Object.entries(pricing.models ?? {}) : [];
    ours.sort(([a], [b]) => {
        const ia = OUR_ORDER.indexOf(a), ib = OUR_ORDER.indexOf(b);
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        return a.localeCompare(b);
    });
    const rows = ours.map(([id, p]) => ({
        id, name: id, vendor: "Infernet (open model, paid batch)", ours: true,
        input_per_m_usd: Number(p.input_per_m_usd), output_per_m_usd: Number(p.output_per_m_usd),
        job_usd: jobCostUsd(p, job)
    }));
    for (const r of refs) rows.push({ ...r, ours: false, job_usd: jobCostUsd(r, job) });
    return rows;
}
