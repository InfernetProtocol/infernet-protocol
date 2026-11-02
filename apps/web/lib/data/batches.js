import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { encryptJSON, decryptJSON } from "@/lib/encrypt";
import { matchServedModel } from "@/lib/model-names";
import { createChatJob, pickChatProvider } from "@/lib/data/chat";
import { getEarningsConfig } from "@/lib/data/earnings";
import { getInferencePricing } from "@/lib/data/billing";
import {
    validateBatch, quoteView, totalMaxMicro, usdToMicro, microToUsd, itemChargeMicro, providerSplitMicro,
    buildReceipt, itemCounts, numericUsdToMicro, parseFunding, fundingBreakdown, QUOTE_TTL_MS, MAX_DISPATCH_ATTEMPTS
} from "@/lib/billing/core";

/**
 * Paid batch inference (DB half). Pure math in lib/billing/core.js; the
 * ledger lives in the SQL functions of 20261102020000_paid_batch_inference.sql.
 *
 *   quote   validate + price, store for 15 minutes; never touches the balance
 *   submit  inference_submit_batch: idempotency, funding (earned / prepaid /
 *           wallet), items and ONE hold for the total max cost, atomically
 *   dispatch  inference_claim_items hands out at most max_in_flight items;
 *           each becomes one chat job via the normal pipeline with smart
 *           routing, pinned to the picked node (no hosted fallback: the house
 *           would pay for it), tagged batch_item_id so it earns no subsidy
 *   settle  on completion (node API) or by the maintenance tick: charge the
 *           server-estimated cost (<= the item's max), release the rest,
 *           credit the provider a confirmed 'paid' earning (charge less the
 *           house fee), dispatch the next queued items
 */

const BATCH_COLUMNS = "id, user_id, user_email, idempotency_key, quote_id, model, status, item_count, max_cost_micro, hold_micro, charged_micro, released_micro, input_micro_per_m, output_micro_per_m, house_fee_pct, max_in_flight, funding, funded_earned_micro, funded_wallet_micro, returned_earned_micro, created_at, updated_at, cancelled_at, completed_at";
const ITEM_COLUMNS = "id, batch_id, idx, custom_id, max_tokens, input_tokens, max_cost_micro, status, attempts, job_id, output_tokens, cost_micro, error, dispatched_at, settled_at, created_at, updated_at";
const STUCK_JOB_MS = 15 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function db(supabase) {
    return supabase ?? getSupabaseServerClient();
}

function withStatus(message, status, extra = {}) {
    return Object.assign(new Error(message), { status, ...extra });
}

async function selectAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await build().range(from, from + 999);
        if (error) throw withStatus(error.message, 500);
        out.push(...(data ?? []));
        if (!data || data.length < 1000) return out;
    }
}

/** Priced models a live, enabled provider serves right now. */
export async function sellableModels(pricing) {
    const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data, error } = await db().from("providers").select("specs")
        .eq("status", "available").is("disabled_at", null).gte("last_seen", since);
    if (error) throw withStatus(error.message, 500);
    const out = new Set();
    for (const model of Object.keys(pricing?.models ?? {})) {
        if ((data ?? []).some((p) => matchServedModel(p?.specs?.served_models, model) !== null)) out.add(model);
    }
    return out;
}

async function validated(body) {
    const pricing = await getInferencePricing();
    if (!pricing.enabled) throw withStatus("paid batch inference is paused", 503);
    const v = validateBatch(body, { pricing, sellable: await sellableModels(pricing) });
    if (!v.ok) throw withStatus(v.errors[0], v.status, { details: v.errors, sellable: v.sellable });
    return { pricing, ...v.value };
}

const storedItems = (items) => items.map((it) => ({
    idx: it.idx,
    custom_id: it.custom_id,
    input: encryptJSON({ messages: it.messages, temperature: it.temperature }),
    max_tokens: it.max_tokens,
    input_tokens: it.input_tokens,
    max_cost_micro: it.max_cost_micro
}));

export async function createQuote(user, body) {
    const { model, price, items } = await validated(body);
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
    const { data, error } = await db().from("inference_batch_quotes").insert({
        user_id: user.id,
        model,
        items: encryptJSON({ items: storedItems(items) }),
        item_count: items.length,
        total_max_micro: totalMaxMicro(items),
        pricing: price,
        expires_at: expiresAt
    }).select("id").single();
    if (error) throw withStatus(error.message, 500);
    return quoteView({ id: data.id, model, price, items, expiresAt });
}

export async function getBatchRow(id) {
    if (!UUID_RE.test(String(id ?? ""))) return null;
    const { data, error } = await db().from("inference_batches").select(BATCH_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw withStatus(error.message, 500);
    return data ?? null;
}

async function batchByKey(user, key) {
    const { data, error } = await db().from("inference_batches").select(BATCH_COLUMNS)
        .eq("user_id", user.id).eq("idempotency_key", key).maybeSingle();
    if (error) throw withStatus(error.message, 500);
    return data ?? null;
}

/**
 * Everything a submit needs before money moves. Returns { existing } for a
 * replayed idempotency key, else the prepared batch.
 */
export async function prepareSubmit(user, body, { accountOrder } = {}) {
    const b = body && typeof body === "object" ? body : {};
    const key = typeof b.idempotency_key === "string" ? b.idempotency_key.trim() : "";
    if (!key || key.length > 128) throw withStatus("idempotency_key is required (1-128 characters)", 400);
    const existing = await batchByKey(user, key);
    if (existing) return { existing };

    if (b.max_cost_usd === undefined || b.max_cost_usd === null) throw withStatus("max_cost_usd is required: the most this batch may cost", 400);
    const maxCostMicro = usdToMicro(typeof b.max_cost_usd === "number" ? b.max_cost_usd : String(b.max_cost_usd));
    if (maxCostMicro === null || maxCostMicro <= 0) throw withStatus("max_cost_usd must be a positive USD amount (at most 6 decimals)", 400);
    const funding = parseFunding(b.funding, accountOrder);
    if (!funding.ok) throw withStatus(funding.error, 400);

    const pricing = await getInferencePricing();
    if (!pricing.enabled) throw withStatus("paid batch inference is paused", 503);

    let model, price, items, quoteId = null;
    if (b.quote_id) {
        if (!UUID_RE.test(String(b.quote_id))) throw withStatus("quote not found", 404);
        const { data: q, error } = await db().from("inference_batch_quotes").select("*").eq("id", b.quote_id).maybeSingle();
        if (error) throw withStatus(error.message, 500);
        if (!q || q.user_id !== user.id) throw withStatus("quote not found", 404);
        if (q.used_batch_id) throw withStatus("this quote was already submitted", 409, { batch_id: q.used_batch_id });
        if (Date.parse(q.expires_at) <= Date.now()) throw withStatus("quote expired: ask for a new one", 410);
        const sellable = await sellableModels(pricing);
        if (!pricing.models[q.model]) throw withStatus(`model "${q.model}" is no longer sold for batch inference`, 400);
        if (!sellable.has(q.model)) throw withStatus(`no live node serves "${q.model}" right now`, 409);
        model = q.model;
        price = q.pricing;
        items = decryptJSON(q.items).items;
        quoteId = q.id;
    } else {
        ({ model, price, items } = await validated(b));
        items = storedItems(items);
    }
    const total = totalMaxMicro(items);
    if (total > maxCostMicro) {
        throw withStatus(`the batch can cost up to $${microToUsd(total)}, above max_cost_usd $${microToUsd(maxCostMicro)}`, 400, { total_max_cost_usd: microToUsd(total) });
    }
    const config = await getEarningsConfig();
    return {
        key,
        model,
        price,
        items,
        quoteId,
        totalMicro: total,
        maxCostMicro,
        sources: funding.sources,
        houseFeePct: config.house_fee_pct,
        maxInFlight: pricing.max_in_flight
    };
}

/**
 * Place the batch and its hold (inference_submit_batch). walletMicro is what
 * this request's own wallet payment just added to the balance. Returns
 * { ok, batch, existing } or { ok:false, reason, ... } from the SQL.
 */
export async function commitSubmit(user, p, { walletMicro = 0 } = {}) {
    const { data, error } = await db().rpc("inference_submit_batch", {
        p_user_id: user.id,
        p_idem: p.key,
        p_batch: {
            model: p.model,
            quote_id: p.quoteId ?? "",
            max_cost_micro: p.maxCostMicro,
            input_micro_per_m: p.price.input_micro_per_m,
            output_micro_per_m: p.price.output_micro_per_m,
            house_fee_pct: p.houseFeePct,
            max_in_flight: p.maxInFlight,
            user_email: user.email ?? null,
            funding: p.sources,
            wallet_micro: walletMicro
        },
        p_items: p.items
    });
    if (error) throw withStatus(error.message, 500);
    if (!data?.ok) return { ok: false, ...data };
    if (!data.existing) await dispatchBatch(data.batch_id);
    return { ok: true, existing: Boolean(data.existing), batch: await getBatchRow(data.batch_id) };
}

/** Hand out queued items up to the batch's in-flight bound. Never throws. */
export async function dispatchBatch(batchId) {
    try {
        const supabase = db();
        const batch = await getBatchRow(batchId);
        if (!batch || batch.status !== "running" || batch.cancelled_at) return { dispatched: 0 };
        const { data: claimed, error } = await supabase.rpc("inference_claim_items", { p_batch_id: batchId });
        if (error) throw error;
        let dispatched = 0;
        for (const item of claimed ?? []) {
            if (await dispatchItem(supabase, batch, item)) dispatched += 1;
        }
        return { dispatched };
    } catch (err) {
        console.warn(`[batches] dispatch ${batchId} failed: ${err?.message ?? err}`);
        return { dispatched: 0, error: String(err?.message ?? err) };
    }
}

async function requeueOrFail(supabase, item, reason) {
    const status = Number(item.attempts) >= MAX_DISPATCH_ATTEMPTS ? "failed" : "requeue";
    await supabase.rpc("inference_settle_item", {
        p_item_id: item.id, p_status: status, p_output_tokens: 0, p_cost_micro: 0, p_error: reason, p_job_id: null
    });
}

async function dispatchItem(supabase, batch, item) {
    try {
        const input = decryptJSON(item.input) ?? {};
        const provider = await pickChatProvider({ modelName: batch.model });
        if (!provider) {
            await requeueOrFail(supabase, item, `no_provider: no free node serves ${batch.model}`);
            return false;
        }
        const { job, source } = await createChatJob({
            messages: input.messages,
            modelName: batch.model,
            maxTokens: item.max_tokens,
            temperature: Number.isFinite(input.temperature) ? input.temperature : 0.7,
            providerId: provider.id,
            pinned: true,
            batchItemId: item.id
        });
        if (source !== "p2p") {
            await requeueOrFail(supabase, item, "no_provider: the picked node went away");
            return false;
        }
        const { error } = await supabase.from("inference_batch_items")
            .update({ job_id: job.id, updated_at: new Date().toISOString() }).eq("id", item.id).eq("status", "dispatched");
        if (error) throw error;
        return true;
    } catch (err) {
        console.warn(`[batches] item ${item.id} dispatch failed: ${err?.message ?? err}`);
        await requeueOrFail(supabase, item, `dispatch error: ${String(err?.message ?? err).slice(0, 200)}`).catch(() => {});
        return false;
    }
}

/**
 * Settle the batch item a finished job served. Idempotent (the SQL settles
 * an item once, and only for its current job). Never throws: a ledger
 * hiccup must not fail the node's completion call; the tick retries.
 *
 * @param {{ id, batch_item_id, provider_id, model_name }} job
 * @param {object} [result]  the job's result ({ text }); the provider's token_count is ignored
 * @param {boolean} failed
 * @param {boolean} [noCharge]  e.g. the provider was disabled: charge 0
 */
export async function settleBatchJob({ job, result, failed, noCharge = false, supabase }) {
    try {
        const client = db(supabase);
        const { data: item, error } = await client.from("inference_batch_items")
            .select(`${ITEM_COLUMNS}, inference_batches!inner(${BATCH_COLUMNS})`)
            .eq("id", job.batch_item_id).maybeSingle();
        if (error) throw error;
        if (!item) return { settled: false, reason: "no item" };
        const batch = item.inference_batches;
        const price = { input_micro_per_m: Number(batch.input_micro_per_m), output_micro_per_m: Number(batch.output_micro_per_m) };
        const completed = !failed && !noCharge;
        const { outputTokens, chargeMicro } = completed
            ? itemChargeMicro({ item: { ...item, max_cost_micro: Number(item.max_cost_micro) }, result, price })
            : { outputTokens: 0, chargeMicro: 0 };
        const { data: s, error: sErr } = await client.rpc("inference_settle_item", {
            p_item_id: item.id,
            p_status: failed ? "failed" : "completed",
            p_output_tokens: outputTokens,
            p_cost_micro: chargeMicro,
            p_error: failed ? (typeof result?.error === "string" ? result.error : "the node reported a failure") : (noCharge ? "provider disabled: not charged" : null),
            p_job_id: job.id
        });
        if (sErr) throw sErr;
        const charged = Number(s?.charged_micro ?? 0);
        if (s?.settled && charged > 0 && job.provider_id) {
            await creditProvider(client, { job, item, batch, chargeMicro: charged, outputTokens });
        }
        if (s?.settled && !s.batch_done) await dispatchBatch(batch.id);
        return s ?? { settled: false };
    } catch (err) {
        console.warn(`[batches] settle job ${job?.id} failed: ${err?.message ?? err}`);
        return { settled: false, error: String(err?.message ?? err) };
    }
}

/** The serving node's share: a confirmed 'paid' earning (the money was prepaid). Idempotent per job. */
async function creditProvider(client, { job, item, batch, chargeMicro, outputTokens }) {
    const { feeMicro, providerMicro } = providerSplitMicro(chargeMicro, batch.house_fee_pct);
    const now = new Date().toISOString();
    const { error } = await client.from("provider_earnings").upsert({
        job_id: job.id,
        provider_id: job.provider_id,
        kind: "paid",
        role: "single",
        share: 1,
        output_tokens: outputTokens,
        tokens_estimated: true,
        held_reason: null,
        rate_per_1k_usd: null,
        gross_usd: microToUsd(chargeMicro),
        fee_usd: microToUsd(feeMicro),
        amount_usd: microToUsd(providerMicro),
        coin: null,
        status: "confirmed",
        model_name: job.model_name ?? batch.model,
        confirmed_at: now,
        earned_at: now,
        metadata: { source: "prepaid_batch", batch_id: batch.id, item_id: item.id, house_fee_pct: Number(batch.house_fee_pct), charge_micro: chargeMicro }
    }, { onConflict: "job_id,provider_id", ignoreDuplicates: true });
    if (error) console.warn(`[batches] provider credit for job ${job.id} failed: ${error.message}`);
}

/**
 * Maintenance tick: settle items whose job finished or died without the
 * completion hook (timeouts, the hourly reaper, lost calls), requeue items
 * claimed but never turned into a job, then dispatch. Bounded per call.
 */
export async function tickBatches({ now = Date.now(), limit = 50 } = {}) {
    const supabase = db();
    const out = { batches: 0, settled: 0, timed_out: 0, requeued: 0, dispatched: 0 };
    const { data: batches, error } = await supabase.from("inference_batches").select("id")
        .eq("status", "running").order("created_at", { ascending: true }).limit(limit);
    if (error) throw withStatus(error.message, 500);
    for (const { id } of batches ?? []) {
        out.batches += 1;
        const { data: open, error: iErr } = await supabase.from("inference_batch_items")
            .select("id, job_id, attempts, dispatched_at").eq("batch_id", id).eq("status", "dispatched").limit(500);
        if (iErr) continue;
        const jobIds = (open ?? []).map((i) => i.job_id).filter(Boolean);
        const jobs = new Map();
        for (let i = 0; i < jobIds.length; i += 200) {
            const { data } = await supabase.from("jobs").select("id, status, provider_id, model_name, batch_item_id, result, error, updated_at")
                .in("id", jobIds.slice(i, i + 200));
            for (const j of data ?? []) jobs.set(j.id, j);
        }
        for (const item of open ?? []) {
            if (!item.job_id) {
                if (now - Date.parse(item.dispatched_at ?? 0) > 5 * 60 * 1000) {
                    await requeueOrFail(supabase, item, "dispatch was interrupted");
                    out.requeued += 1;
                }
                continue;
            }
            const job = jobs.get(item.job_id);
            if (!job) continue;
            if (job.status === "completed" || job.status === "failed") {
                let result = null;
                try { result = decryptJSON(job.result); } catch { /* charge 0 below */ }
                const r = await settleBatchJob({ job, result: job.status === "failed" ? { error: job.error } : result, failed: job.status === "failed" || !result, supabase });
                if (r.settled) out.settled += 1;
            } else if (now - Date.parse(job.updated_at) > STUCK_JOB_MS) {
                const stamp = new Date(now).toISOString();
                const { data: marked } = await supabase.from("jobs")
                    .update({ status: "failed", error: "batch timeout: not finished within 15 minutes", completed_at: stamp, updated_at: stamp })
                    .eq("id", job.id).in("status", ["pending", "assigned", "running"]).select("id");
                if (marked?.length) {
                    const r = await settleBatchJob({ job, result: { error: "timeout" }, failed: true, supabase });
                    if (r.settled) out.timed_out += 1;
                }
            }
        }
        out.dispatched += (await dispatchBatch(id)).dispatched;
    }
    return out;
}

export async function cancelBatch(user, id) {
    const batch = await getBatchRow(id);
    if (!batch || batch.user_id !== user.id) throw withStatus("batch not found", 404);
    const { data, error } = await db().rpc("inference_cancel_batch", { p_batch_id: id, p_user_id: user.id });
    if (error) throw withStatus(error.message, 500);
    return { cancelled_items: data?.cancelled_items ?? 0, batch: await batchView(user, id) };
}

async function loadOwned(user, id) {
    const batch = await getBatchRow(id);
    if (!batch || batch.user_id !== user.id) throw withStatus("batch not found", 404);
    const items = await selectAll(() => db().from("inference_batch_items").select(ITEM_COLUMNS).eq("batch_id", id).order("idx"));
    return { batch, items };
}

async function outputsFor(items) {
    const ids = items.filter((i) => i.status === "completed" && i.job_id).map((i) => i.job_id);
    const out = new Map();
    for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db().from("jobs").select("id, result").in("id", ids.slice(i, i + 200));
        if (error) throw withStatus(error.message, 500);
        for (const j of data ?? []) {
            let r = null;
            try { r = decryptJSON(j.result); } catch { /* unreadable */ }
            out.set(j.id, typeof r?.text === "string" ? r.text : null);
        }
    }
    return out;
}

function itemView(i, outputs) {
    return {
        custom_id: i.custom_id,
        status: i.status,
        estimated_input_tokens: i.input_tokens,
        estimated_output_tokens: i.output_tokens ?? null,
        max_cost_usd: microToUsd(i.max_cost_micro),
        cost_usd: i.cost_micro === null || i.cost_micro === undefined ? null : microToUsd(i.cost_micro),
        error: i.error ?? null,
        ...(outputs ? { output: i.status === "completed" ? (outputs.get(i.job_id) ?? null) : null } : {})
    };
}

export function publicBatch(batch, items, outputs = null) {
    return {
        id: batch.id,
        model: batch.model,
        status: batch.status,
        cancelling: Boolean(batch.cancelled_at) && batch.status === "running",
        counts: itemCounts(items),
        max_cost_usd: microToUsd(batch.max_cost_micro),
        held_usd: microToUsd(batch.hold_micro),
        cost_so_far_usd: microToUsd(batch.charged_micro),
        released_usd: microToUsd(batch.released_micro),
        funding: fundingBreakdown(batch),
        created_at: batch.created_at,
        completed_at: batch.completed_at,
        cancelled_at: batch.cancelled_at,
        items: items.map((i) => itemView(i, outputs)),
        token_counts: "server-side estimates: ceil(characters / 4)"
    };
}

/** GET /api/v1/batches/:id. Outputs are included once the batch is finished. */
export async function batchView(user, id) {
    const { batch, items } = await loadOwned(user, id);
    const outputs = batch.status === "running" ? null : await outputsFor(items);
    return publicBatch(batch, items, outputs);
}

/** JSONL, one line per item in submit order. */
export async function batchResults(user, id) {
    const { batch, items } = await loadOwned(user, id);
    const outputs = await outputsFor(items);
    return {
        batch,
        jsonl: items.map((i) => JSON.stringify({
            custom_id: i.custom_id,
            status: i.status,
            output: i.status === "completed" ? (outputs.get(i.job_id) ?? null) : null,
            estimated_tokens: { input: i.input_tokens, output: i.output_tokens ?? 0 },
            cost_usd: i.cost_micro === null || i.cost_micro === undefined ? null : microToUsd(i.cost_micro),
            error: i.error ?? null
        })).join("\n") + (items.length ? "\n" : "")
    };
}

export async function batchReceipt(user, id) {
    const { batch, items } = await loadOwned(user, id);
    const jobIds = items.map((i) => i.job_id).filter(Boolean);
    let providerMicro = 0;
    for (let i = 0; i < jobIds.length; i += 200) {
        const { data, error } = await db().from("provider_earnings").select("amount_usd, metadata")
            .eq("kind", "paid").in("job_id", jobIds.slice(i, i + 200));
        if (error) throw withStatus(error.message, 500);
        for (const e of data ?? []) {
            if (e.metadata?.batch_id === batch.id) providerMicro += numericUsdToMicro(e.amount_usd);
        }
    }
    return buildReceipt({ batch, items, providerMicro });
}
