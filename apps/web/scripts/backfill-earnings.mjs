#!/usr/bin/env node
/**
 * Credit every completed job that has no provider_earnings row yet.
 *
 * Jobs completed before the ledger existed (and any a completion path missed)
 * get the same credit a live completion would write: the provider share of a
 * paid job, or the house subsidy per 1k output tokens on a free one, which is
 * 'pending_approval' until the rate is approved. Idempotent: (job_id,
 * provider_id) is unique and duplicates are ignored, so it is safe to re-run.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... INFERNET_DB_ENCRYPTION_KEY=... \
 *     node apps/web/scripts/backfill-earnings.mjs [--dry-run] [--provider <uuid>]
 *
 * Uses PostgREST directly (no npm deps) so it runs from a plain checkout.
 */

import { decryptJSON } from "../lib/encrypt.js";
import { resolveEarningsConfig, computeJobCredits } from "../lib/earnings/core.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const providerArg = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : null;

const base = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!base || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(2);
}
const schema = process.env.SUPABASE_SCHEMA || "public";
const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "accept-profile": schema,
    "content-profile": schema
};

async function rest(path, init = {}) {
    const res = await fetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

async function all(path) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const page = await rest(path, { headers: { range: `${from}-${from + 999}`, "range-unit": "items" } });
        out.push(...page);
        if (page.length < 1000) return out;
    }
}

const settingsRows = await rest("settings?key=eq.earnings&select=value");
const config = resolveEarningsConfig({ settings: settingsRows?.[0]?.value ?? null });
console.log(`config: ${JSON.stringify(config)}`);

let jobFilter = "status=eq.completed&provider_id=not.is.null";
if (providerArg) jobFilter += `&provider_id=eq.${encodeURIComponent(providerArg)}`;
const jobs = await all(
    `jobs?${jobFilter}&select=id,provider_id,payment_offer,payment_coin,payment_status,model_name,completed_at,created_at,result&order=created_at.asc`
);
const credited = new Set(
    (await all("provider_earnings?select=job_id")).map((r) => r.job_id)
);
const todo = jobs.filter((j) => !credited.has(j.id));
console.log(`completed jobs with a provider: ${jobs.length}; already credited: ${jobs.length - todo.length}; to credit: ${todo.length}`);

const rows = [];
let undecryptable = 0;
for (const job of todo) {
    let result = null;
    try {
        result = decryptJSON(job.result);
    } catch {
        undecryptable += 1;
    }
    rows.push(...computeJobCredits({
        job: { ...job, completed_at: job.completed_at ?? job.created_at },
        result,
        config,
        source: "backfill-2026-10-22"
    }));
}

const byProvider = new Map();
for (const r of rows) {
    const p = byProvider.get(r.provider_id) ?? { jobs: 0, tokens: 0, usd: 0 };
    p.jobs += 1;
    p.tokens += r.output_tokens;
    p.usd += r.amount_usd;
    byProvider.set(r.provider_id, p);
}
const total = rows.reduce((a, r) => a + r.amount_usd, 0);
console.log(`rows: ${rows.length} across ${byProvider.size} providers, $${total.toFixed(6)} total; undecryptable results: ${undecryptable}`);
for (const [id, p] of [...byProvider.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
    console.log(`  ${id}  ${String(p.jobs).padStart(4)} jobs  ${String(p.tokens).padStart(8)} tok  $${p.usd.toFixed(6)}`);
}

if (dryRun) {
    console.log("dry run: nothing written");
    process.exit(0);
}

let written = 0;
for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const out = await rest("provider_earnings?on_conflict=job_id,provider_id", {
        method: "POST",
        headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(batch)
    });
    written += out?.length ?? 0;
}
console.log(`written: ${written} (duplicates ignored: ${rows.length - written})`);
