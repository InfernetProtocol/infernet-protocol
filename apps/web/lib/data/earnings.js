import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
    resolveEarningsConfig,
    computeJobCredits,
    summariseBalance,
    checkPayoutRequest,
    isAutoApprovable,
    OPEN_PAYOUT_STATUSES
} from "@/lib/earnings/core";

/**
 * Provider earnings ledger + payout requests (DB half). The math lives in
 * lib/earnings/core.js; see the header there for the model.
 *
 * Money only leaves through approvePayoutRequest(): an admin calls it, or
 * requestPayout() does for a request at or below auto_approve_max_usd.
 */

const SETTINGS_KEY = "earnings";

function db(supabase) {
    return supabase ?? getSupabaseServerClient();
}

function withStatus(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
}

export async function getEarningsConfig(supabase) {
    let settings = null;
    try {
        const { data } = await db(supabase)
            .from("settings")
            .select("value")
            .eq("key", SETTINGS_KEY)
            .maybeSingle();
        settings = data?.value ?? null;
    } catch {
        /* defaults + env */
    }
    return resolveEarningsConfig({ settings });
}

/**
 * Admin: change the rate / fee / minimum, or approve the subsidy. A rate
 * change re-prices every subsidy credit still pending approval; approving
 * confirms them (confirmed credits never change).
 */
export async function updateEarningsConfig(patch, { actor } = {}) {
    const supabase = db();
    const current = await getEarningsConfig(supabase);
    const next = resolveEarningsConfig({ settings: { ...current, ...patch } });
    const { error } = await supabase
        .from("settings")
        .upsert(
            { key: SETTINGS_KEY, value: { ...next, updated_by: actor ?? null }, updated_at: new Date().toISOString() },
            { onConflict: "key" }
        );
    if (error) throw withStatus(error.message, 500);
    // Credits pending approval carry no decided rate yet: re-price them all
    // (before any approval below confirms them at that rate).
    let repriced = 0;
    if (next.subsidy_per_1k_output_usd !== current.subsidy_per_1k_output_usd) {
        const { data, error: rpcErr } = await supabase.rpc("reprice_pending_subsidy", {
            new_rate: next.subsidy_per_1k_output_usd
        });
        if (rpcErr) throw withStatus(rpcErr.message, 500);
        repriced = Number(data) || 0;
    }
    let confirmed = 0;
    if (next.subsidy_approved && !current.subsidy_approved) {
        confirmed = await confirmPendingSubsidy(supabase);
    }
    return { config: next, repriced_subsidy_credits: repriced, confirmed_subsidy_credits: confirmed };
}

async function confirmPendingSubsidy(supabase) {
    const { data, error } = await supabase
        .from("provider_earnings")
        .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
        .eq("kind", "subsidy")
        .eq("status", "pending_approval")
        .select("id");
    if (error) throw withStatus(error.message, 500);
    return data?.length ?? 0;
}

/**
 * Credit a completed job. Idempotent: (job_id, provider_id) is unique and a
 * repeat is ignored, so retried completions and the backfill never double-pay.
 * Never throws: a ledger hiccup must not fail the job completion.
 */
export async function creditCompletedJob({ supabase, job, result, shares, source }) {
    try {
        const client = db(supabase);
        const config = await getEarningsConfig(client);
        const rows = computeJobCredits({ job, result, shares, config, source });
        if (rows.length === 0) return { credited: 0 };
        const { error } = await client
            .from("provider_earnings")
            .upsert(rows, { onConflict: "job_id,provider_id", ignoreDuplicates: true });
        if (error) {
            console.warn(`provider_earnings insert failed: ${error.message}`);
            return { credited: 0, error: error.message };
        }
        return { credited: rows.length };
    } catch (err) {
        console.warn(`provider_earnings credit failed: ${err?.message ?? err}`);
        return { credited: 0, error: String(err?.message ?? err) };
    }
}

/** CoinPay confirmed the client's payment: its provider credits are now real. */
export async function confirmPaidJobCredits(jobId, supabase) {
    const { data, error } = await db(supabase)
        .from("provider_earnings")
        .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
        .eq("job_id", jobId)
        .eq("kind", "paid")
        .eq("status", "pending")
        .select("id");
    if (error) throw withStatus(error.message, 500);
    return data?.length ?? 0;
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

/**
 * Balance + recent ledger + payout history for a set of providers (one node
 * from the CLI, every node a user owns on the dashboard).
 */
export async function getEarningsForProviders(providerIds, { recent = 20 } = {}) {
    const ids = (providerIds ?? []).filter(Boolean);
    const config = await getEarningsConfig();
    if (ids.length === 0) {
        return { balance: summariseBalance([], []), per_provider: {}, recent: [], payouts: [], config: publicConfig(config) };
    }
    const supabase = db();
    const [earnings, payouts] = await Promise.all([
        selectAll(() => supabase
            .from("provider_earnings")
            .select("id, job_id, provider_id, kind, role, output_tokens, rate_per_1k_usd, amount_usd, fee_usd, status, model_name, earned_at")
            .in("provider_id", ids)
            .order("earned_at", { ascending: false })),
        selectAll(() => supabase
            .from("payout_requests")
            .select("id, provider_id, amount_usd, coin, network, address, status, tx_hash, error, created_at, approved_at, sent_at")
            .in("provider_id", ids)
            .order("created_at", { ascending: false }))
    ]);
    const perProvider = {};
    for (const id of ids) {
        const providerEarnings = earnings.filter((e) => e.provider_id === id);
        perProvider[id] = {
            ...summariseBalance(
                providerEarnings,
                payouts.filter((p) => p.provider_id === id)
            ),
            latest_earned_at: providerEarnings[0]?.earned_at ?? null
        };
    }
    return {
        balance: summariseBalance(earnings, payouts),
        per_provider: perProvider,
        recent: earnings.slice(0, recent),
        payouts: payouts.slice(0, 20),
        config: publicConfig(config)
    };
}

/** Per-job earned amounts for a list of jobs (dashboard + node page tables). */
export async function getEarningsByJob(jobIds) {
    const ids = (jobIds ?? []).filter(Boolean);
    if (ids.length === 0) return new Map();
    const { data, error } = await db()
        .from("provider_earnings")
        .select("job_id, provider_id, amount_usd, status, kind, output_tokens")
        .in("job_id", ids);
    if (error) throw withStatus(error.message, 500);
    const out = new Map();
    for (const row of data ?? []) {
        const prev = out.get(row.job_id);
        out.set(row.job_id, prev
            ? { ...prev, amount_usd: Number(prev.amount_usd) + Number(row.amount_usd) }
            : { ...row, amount_usd: Number(row.amount_usd) });
    }
    return out;
}

export function publicConfig(config) {
    return {
        subsidy_per_1k_output_usd: config.subsidy_per_1k_output_usd,
        subsidy_approved: config.subsidy_approved,
        house_fee_pct: config.house_fee_pct,
        min_payout_usd: config.min_payout_usd,
        auto_approve_max_usd: config.auto_approve_max_usd
    };
}

async function providerIdForPubkey(pubkey) {
    const { data, error } = await db()
        .from("providers")
        .select("id")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (error) throw withStatus(error.message, 500);
    if (!data) throw withStatus("no provider row for this pubkey", 404);
    return data.id;
}

export async function getEarningsForNode({ pubkey, recent = 20 }) {
    const id = await providerIdForPubkey(pubkey);
    const out = await getEarningsForProviders([id], { recent: Math.min(Math.max(Number(recent) || 20, 1), 100) });
    return { provider_id: id, ...out, per_provider: undefined };
}

/**
 * Queue a withdrawal. Snapshots the default payout address so a later
 * address change cannot redirect an approved payout. A request at or below
 * auto_approve_max_usd is approved and sent right away; if that send does not
 * go out it stays queued for an admin, and the request itself still stands.
 */
export async function requestPayout({ providerId, amountUsd = null, via = "cli", send } = {}) {
    const supabase = db();
    const [config, { data: addresses, error: addrErr }, summary] = await Promise.all([
        getEarningsConfig(supabase),
        supabase
            .from("provider_payouts")
            .select("coin, network, address, is_default, created_at")
            .eq("provider_id", providerId)
            .order("is_default", { ascending: false })
            .order("created_at", { ascending: false }),
        getEarningsForProviders([providerId])
    ]);
    if (addrErr) throw withStatus(addrErr.message, 500);
    const address = (addresses ?? [])[0] ?? null;
    const hasOpenRequest = summary.payouts.some((p) => OPEN_PAYOUT_STATUSES.includes(p.status));
    const check = checkPayoutRequest({
        balance: summary.balance,
        amountUsd,
        config,
        hasAddress: Boolean(address),
        hasOpenRequest
    });
    if (!check.ok) throw withStatus(check.error, 400);

    const { data, error } = await supabase
        .from("payout_requests")
        .insert({
            provider_id: providerId,
            amount_usd: check.amount,
            coin: address.coin,
            network: address.network,
            address: address.address,
            status: "requested",
            requested_via: via
        })
        .select()
        .single();
    if (error) {
        // The partial unique index refuses a second open request in a race.
        if (/payout_requests_one_open|duplicate key/.test(error.message)) {
            throw withStatus("a payout request is already waiting for approval", 409);
        }
        throw withStatus(error.message, 500);
    }
    if (isAutoApprovable(data.amount_usd, config)) {
        try {
            const out = await approvePayoutRequest(data.id, { actor: "auto-approve", send });
            return { request: out.request, outcome: out.outcome, auto_approved: true, balance: summary.balance };
        } catch (err) {
            console.warn(`payout auto-approve ${data.id} failed: ${err?.message ?? err}`);
        }
    }
    return { request: data, balance: summary.balance };
}

export async function requestPayoutForNode({ pubkey, amountUsd }) {
    const providerId = await providerIdForPubkey(pubkey);
    return requestPayout({ providerId, amountUsd, via: "cli" });
}

// ---- admin ------------------------------------------------------------------

export async function listPayoutRequests({ status = "requested", limit = 100 } = {}) {
    const supabase = db();
    let q = supabase
        .from("payout_requests")
        .select("*, providers(name, node_id)")
        .order("created_at", { ascending: true })
        .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));
    if (status && status !== "all") q = q.in("status", String(status).split(","));
    const { data, error } = await q;
    if (error) throw withStatus(error.message, 500);
    const rows = data ?? [];
    const balances = rows.length
        ? (await getEarningsForProviders([...new Set(rows.map((r) => r.provider_id))])).per_provider
        : {};
    return {
        rows: rows.map((r) => ({
            ...r,
            provider_name: r.providers?.name ?? null,
            provider_node_id: r.providers?.node_id ?? null,
            providers: undefined,
            balance: balances[r.provider_id] ?? null
        }))
    };
}

/** Ledger-wide totals for the admin page: what the house owes, by status. */
export async function getLedgerTotals() {
    const rows = await selectAll(() => db()
        .from("provider_earnings")
        .select("kind, status, amount_usd, provider_id"));
    const totals = {};
    for (const r of rows) {
        const k = `${r.kind}:${r.status}`;
        totals[k] = (totals[k] ?? 0) + Number(r.amount_usd || 0);
    }
    return {
        credits: rows.length,
        providers: new Set(rows.map((r) => r.provider_id)).size,
        totals_usd: totals,
        config: publicConfig(await getEarningsConfig())
    };
}

async function ownerEmail(supabase, providerId) {
    try {
        const { data: prov } = await supabase.from("providers").select("public_key").eq("id", providerId).maybeSingle();
        if (prov?.public_key) {
            const { data: link } = await supabase
                .from("pubkey_links")
                .select("user_id")
                .eq("pubkey", prov.public_key)
                .limit(1)
                .maybeSingle();
            if (link?.user_id) {
                const { data } = await supabase.auth.admin.getUserById(link.user_id);
                if (data?.user?.email) return data.user.email;
            }
        }
    } catch {
        /* fall through */
    }
    return `provider-${providerId}@payouts.infernetprotocol.com`;
}

/**
 * Admin approves one request: re-checks the balance, then sends it through
 * CoinPay. An unknown outcome (timeout, 5xx) stays 'sending' so nobody can
 * send it twice; it needs a chain check before it is marked sent or failed.
 */
export async function approvePayoutRequest(id, { actor, send } = {}) {
    const supabase = db();
    const { data: reqRow, error } = await supabase.from("payout_requests").select("*").eq("id", id).maybeSingle();
    if (error) throw withStatus(error.message, 500);
    if (!reqRow) throw withStatus("payout request not found", 404);
    if (reqRow.status !== "requested") throw withStatus(`payout request is ${reqRow.status}, not requested`, 409);

    // Balance excluding this request itself must still cover it.
    const { balance } = await getEarningsForProviders([reqRow.provider_id]);
    const coverable = Number(balance.available_usd) + Number(reqRow.amount_usd);
    if (Number(reqRow.amount_usd) > coverable + 1e-9) {
        throw withStatus(`balance no longer covers $${reqRow.amount_usd}`, 409);
    }

    // Real money: the sealed operator payout key must be open BEFORE the request
    // is claimed, so a locked vault leaves it 'requested' (423 to the admin).
    let payoutKey = null;
    if (!send) payoutKey = await (await import("@/lib/operator-vault")).payoutKey();

    const now = new Date().toISOString();
    // Claim it: only one approver can move requested -> sending.
    const { data: claimed, error: claimErr } = await supabase
        .from("payout_requests")
        .update({ status: "sending", approved_by: actor ?? null, approved_at: now, updated_at: now })
        .eq("id", id)
        .eq("status", "requested")
        .select("id");
    if (claimErr) throw withStatus(claimErr.message, 500);
    if (!claimed?.length) throw withStatus("payout request was already handled", 409);

    const createPayout = (await import("@infernetprotocol/payments")).createPayout;
    const sender = send ?? ((p) => createPayout({ ...p, apiKey: payoutKey }));
    const { toCoinpayMethod } = await import("@infernetprotocol/payments");
    const cryptocurrency = toCoinpayMethod(reqRow.coin, reqRow.network);
    let outcome;
    try {
        outcome = await sender({
            recipientEmail: await ownerEmail(supabase, reqRow.provider_id),
            recipientWallet: reqRow.address,
            amountUsd: Number(reqRow.amount_usd),
            cryptocurrency,
            metadata: { payout_request_id: id, provider_id: reqRow.provider_id }
        });
    } catch (err) {
        outcome = { outcome: "failed", error: String(err?.message ?? err) };
    }

    const done = new Date().toISOString();
    const notSent = outcome.outcome === "failed" && !outcome.payoutId;
    let patch;
    if (outcome.outcome === "sent") {
        patch = { status: "sent", sent_at: done, tx_hash: outcome.txHash, gateway_payout_id: outcome.payoutId ?? null, error: null };
    } else if (notSent) {
        // CoinPay refused before creating a payout (no send wallet, house
        // balance short, rate lookup): nothing left. Put it back in the queue
        // so it can be approved again once that is fixed, instead of failing
        // the provider's request for a problem on our side.
        patch = {
            status: "requested",
            approved_by: null,
            approved_at: null,
            error: `not sent: ${String(outcome.error ?? "payout refused").slice(0, 480)}`
        };
    } else if (outcome.outcome === "failed") {
        patch = { status: "failed", error: String(outcome.error ?? "payout failed").slice(0, 500), gateway_payout_id: outcome.payoutId ?? null };
    } else {
        patch = {
            status: "sending",
            error: `outcome unknown: ${String(outcome.error ?? "").slice(0, 300)} (check the chain before marking sent or failed)`,
            gateway_payout_id: outcome.payoutId ?? null
        };
    }
    patch.updated_at = done;
    const { data: updated, error: upErr } = await supabase
        .from("payout_requests")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
    if (upErr) throw withStatus(upErr.message, 500);

    if (outcome.outcome === "sent") {
        await supabase.from("payment_transactions").insert({
            direction: "outbound",
            provider_id: reqRow.provider_id,
            coin: reqRow.coin,
            network: reqRow.network,
            amount: Number(reqRow.amount_usd),
            amount_usd: Number(reqRow.amount_usd),
            address: reqRow.address,
            tx_hash: outcome.txHash,
            status: "confirmed",
            provider_gateway: "coinpayportal",
            confirmed_at: done,
            metadata: { payout_request_id: id }
        }).then(({ error: e }) => e && console.warn(`payout audit row failed: ${e.message}`));
    }
    return { request: updated, outcome: notSent ? "not_sent" : outcome.outcome };
}

export async function rejectPayoutRequest(id, { actor, reason } = {}) {
    const now = new Date().toISOString();
    const { data, error } = await db()
        .from("payout_requests")
        .update({ status: "rejected", approved_by: actor ?? null, error: reason ? String(reason).slice(0, 500) : null, updated_at: now })
        .eq("id", id)
        .eq("status", "requested")
        .select()
        .maybeSingle();
    if (error) throw withStatus(error.message, 500);
    if (!data) throw withStatus("payout request not found or not waiting", 409);
    return { request: data };
}

/** Admin resolves a 'sending' request after checking the chain. */
export async function resolveSendingPayout(id, { actor, txHash = null, failed = false }) {
    const now = new Date().toISOString();
    const patch = failed
        ? { status: "failed", error: `marked failed by ${actor ?? "admin"} after chain check`, updated_at: now }
        : { status: "sent", tx_hash: txHash, sent_at: now, error: null, updated_at: now };
    if (!failed && !txHash) throw withStatus("tx_hash is required to mark a payout sent", 400);
    const { data, error } = await db()
        .from("payout_requests")
        .update(patch)
        .eq("id", id)
        .eq("status", "sending")
        .select()
        .maybeSingle();
    if (error) throw withStatus(error.message, 500);
    if (!data) throw withStatus("payout request not found or not sending", 409);
    return { request: data };
}
