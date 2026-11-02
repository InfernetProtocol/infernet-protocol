/**
 * Paid batch inference: the pure half (no DB, no network), so the money math
 * is testable on its own. lib/data/batches.js does the reads and writes and
 * the SQL functions in supabase/migrations/20261102020000_paid_batch_inference.sql
 * hold the ledger invariants.
 *
 * Money is integer micro-USD (1 USD = 1,000,000 micro) from the moment it is
 * parsed. Prices are integer micro-USD per 1M tokens. No float is ever used
 * for ledger math; BigInt does the multiplications.
 *
 * Billing tokens are ESTIMATED BY THE SERVER, never taken from the provider:
 *   input  = ceil(characters of the message contents / 4)
 *   output = ceil(characters of the returned text / 4), at most max_tokens
 * Rounding: each item's cost is rounded UP to the next micro-dollar, once.
 */

export const MICRO = 1_000_000;
export const QUOTE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_IN_FLIGHT = 8;
export const MAX_DISPATCH_ATTEMPTS = 12;
export const MAX_ITEM_CHARS = 64_000;
export const MAX_MESSAGES_PER_ITEM = 64;
export const MAX_TOPUP_USD = 10_000;
export const ROLES = new Set(["system", "user", "assistant"]);

export const DEFAULT_INFERENCE_PRICING = Object.freeze({
    enabled: true,
    models: {
        "qwen2.5:7b": { input_per_m_usd: 0.05, output_per_m_usd: 0.2 },
        "qwen2.5:1.5b": { input_per_m_usd: 0.02, output_per_m_usd: 0.08 },
        "qwen2.5:0.5b": { input_per_m_usd: 0.01, output_per_m_usd: 0.04 }
    },
    min_topup_usd: 5,
    max_items_per_batch: 1000,
    max_tokens_cap: 4096,
    max_in_flight: DEFAULT_MAX_IN_FLIGHT
});

/**
 * Exact decimal USD -> integer micro-USD. Accepts a number or a decimal
 * string with at most 6 fraction digits; anything else (negative, NaN,
 * exponent, more precision) returns null. Parsing goes through the decimal
 * text, never through float multiplication.
 */
export function usdToMicro(v) {
    if (typeof v === "number") {
        if (!Number.isFinite(v) || v < 0) return null;
        v = String(v);
        if (/e/i.test(v)) {
            // Small numbers stringify as 1e-7: format with 6 decimals only if exact.
            const fixed = Number(v).toFixed(6);
            if (Number(fixed) !== Number(v)) return null;
            v = fixed;
        }
    }
    if (typeof v !== "string") return null;
    const m = /^(\d{1,12})(?:\.(\d{0,6}))?$/.exec(v.trim());
    if (!m) return null;
    const frac = (m[2] ?? "").padEnd(6, "0");
    return Number(BigInt(m[1]) * 1_000_000n + BigInt(frac || "0"));
}

/** A Postgres numeric USD string ("0.00098000") -> micro-USD, truncated past 6 decimals. */
export function numericUsdToMicro(v) {
    const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(String(v ?? "").trim());
    if (!m) return 0;
    const n = BigInt(m[2]) * 1_000_000n + BigInt(((m[3] ?? "") + "000000").slice(0, 6));
    return Number(m[1] ? -n : n);
}

/** Integer micro-USD -> "1.234567" (exact, 6 decimals). */
export function microToUsd(micro) {
    const n = BigInt(Math.trunc(Number(micro) || 0));
    const neg = n < 0n;
    const a = neg ? -n : n;
    const s = `${a / 1_000_000n}.${String(a % 1_000_000n).padStart(6, "0")}`;
    return neg ? `-${s}` : s;
}

function ceilDiv(a, b) {
    return (a + b - 1n) / b;
}

function bool(v, fallback) {
    if (v === true || v === "true" || v === "1" || v === 1) return true;
    if (v === false || v === "false" || v === "0" || v === 0) return false;
    return fallback;
}

function intIn(v, lo, hi, fallback) {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function priceOk(v) {
    const micro = usdToMicro(v);
    return micro !== null && micro <= 1000 * MICRO ? micro : null;
}

/** A models map with every price valid, or null. */
export function cleanModels(models) {
    if (!models || typeof models !== "object" || Array.isArray(models)) return null;
    const out = {};
    for (const [name, p] of Object.entries(models)) {
        if (typeof name !== "string" || !name || name.length > 200) return null;
        const i = priceOk(p?.input_per_m_usd);
        const o = priceOk(p?.output_per_m_usd);
        if (i === null || o === null) return null;
        out[name] = { input_per_m_usd: Number(p.input_per_m_usd), output_per_m_usd: Number(p.output_per_m_usd) };
    }
    return out;
}

/**
 * Live pricing: defaults < env < settings row 'inference_pricing'. A bad
 * value falls back to the layer below, so a typo can never make inference
 * free or unbounded. INFERNET_INFERENCE_PRICING_ENABLED=false (env) or
 * enabled:false (settings) is the kill switch for new quotes and submits.
 */
export function resolveInferencePricing({ env = process.env, settings = null } = {}) {
    const d = DEFAULT_INFERENCE_PRICING;
    const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    const envEnabled = bool(env.INFERNET_INFERENCE_PRICING_ENABLED, d.enabled);
    return {
        enabled: bool(s.enabled, envEnabled),
        models: cleanModels(s.models) ?? { ...d.models },
        min_topup_usd: priceOk(s.min_topup_usd) !== null && Number(s.min_topup_usd) >= 1 ? Number(s.min_topup_usd) : d.min_topup_usd,
        max_items_per_batch: intIn(s.max_items_per_batch, 1, 10_000, d.max_items_per_batch),
        max_tokens_cap: intIn(s.max_tokens_cap, 1, 32_768, d.max_tokens_cap),
        max_in_flight: intIn(s.max_in_flight, 1, 64, d.max_in_flight)
    };
}

/** Validate an admin patch; returns { ok, value } or { ok:false, errors }. */
export function validatePricingPatch(patch, current) {
    const errors = [];
    const p = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
    if ("enabled" in p && typeof p.enabled !== "boolean") errors.push("enabled must be true or false");
    if ("models" in p && cleanModels(p.models) === null) errors.push("models must map model ids to { input_per_m_usd, output_per_m_usd }, each 0-1000 with at most 6 decimals");
    if ("min_topup_usd" in p && !(priceOk(p.min_topup_usd) !== null && Number(p.min_topup_usd) >= 1)) errors.push("min_topup_usd must be at least 1");
    if ("max_items_per_batch" in p && intIn(p.max_items_per_batch, 1, 10_000, null) === null) errors.push("max_items_per_batch must be 1-10000");
    if ("max_tokens_cap" in p && intIn(p.max_tokens_cap, 1, 32_768, null) === null) errors.push("max_tokens_cap must be 1-32768");
    if ("max_in_flight" in p && intIn(p.max_in_flight, 1, 64, null) === null) errors.push("max_in_flight must be 1-64");
    if (errors.length) return { ok: false, errors };
    return { ok: true, value: resolveInferencePricing({ env: {}, settings: { ...current, ...p } }) };
}

/** Micro-USD per 1M tokens for a model, or null when it is not priced. */
export function modelPriceMicro(pricing, model) {
    const p = pricing?.models?.[model];
    if (!p) return null;
    const input = usdToMicro(p.input_per_m_usd);
    const output = usdToMicro(p.output_per_m_usd);
    if (input === null || output === null) return null;
    return { input_micro_per_m: input, output_micro_per_m: output };
}

/** Characters of the message contents (string content, or text parts). */
export function messagesChars(messages) {
    let n = 0;
    for (const m of Array.isArray(messages) ? messages : []) {
        const c = m?.content;
        if (typeof c === "string") n += c.length;
        else if (Array.isArray(c)) for (const part of c) if (typeof part?.text === "string") n += part.text.length;
    }
    return n;
}

/** Estimated tokens: ceil(chars / 4). */
export function estimateTokensFromChars(chars) {
    const n = Math.max(0, Math.floor(Number(chars) || 0));
    return Math.ceil(n / 4);
}

export function estimateInputTokens(messages) {
    return estimateTokensFromChars(messagesChars(messages));
}

/** Estimated output tokens of a result, at most maxTokens. The provider's own count is ignored. */
export function estimateOutputTokens(result, maxTokens) {
    const text = typeof result === "string" ? result : (typeof result?.text === "string" ? result.text : "");
    const est = estimateTokensFromChars(text.length);
    const cap = Number.isInteger(maxTokens) && maxTokens >= 0 ? maxTokens : est;
    return Math.min(est, cap);
}

/** cost = ceil((in x in_price + out x out_price) / 1M), integer micro-USD. */
export function costMicro({ inputTokens, outputTokens, input_micro_per_m, output_micro_per_m }) {
    const a = BigInt(Math.max(0, Math.floor(inputTokens || 0))) * BigInt(input_micro_per_m)
        + BigInt(Math.max(0, Math.floor(outputTokens || 0))) * BigInt(output_micro_per_m);
    return Number(ceilDiv(a, 1_000_000n));
}

/** The most an item can cost: its input estimate plus max_tokens of output. */
export function itemMaxCostMicro({ inputTokens, maxTokens, ...price }) {
    return costMicro({ inputTokens, outputTokens: maxTokens, ...price });
}

/**
 * What a finished item is charged: the server's estimate, never above the
 * item's max (output is clamped to max_tokens, and the result is clamped again).
 */
export function itemChargeMicro({ item, result, price }) {
    const outputTokens = estimateOutputTokens(result, item.max_tokens);
    const cost = costMicro({ inputTokens: item.input_tokens, outputTokens, ...price });
    return { outputTokens, chargeMicro: Math.min(cost, Number(item.max_cost_micro)) };
}

/**
 * Provider share of a charge. The house fee (house_fee_pct, read from the
 * 'earnings' settings) is rounded DOWN to the micro-dollar and the provider
 * gets the rest, so rounding always favours the operator: they never get
 * less than (100 - fee)% of what the customer paid. (Rounding the fee up gave
 * the house 100% of every 1-micro item.) Returns integer micro-USD.
 */
export function providerSplitMicro(chargeMicro, houseFeePct) {
    const bps = BigInt(Math.round(Math.min(Math.max(Number(houseFeePct) || 0, 0), 100) * 100));
    const charge = BigInt(Math.max(0, Math.floor(Number(chargeMicro) || 0)));
    const fee = (charge * bps) / 10_000n; // BigInt division truncates: floor for non-negatives
    const capped = fee > charge ? charge : fee;
    return { feeMicro: Number(capped), providerMicro: Number(charge - capped) };
}

function err(errors, msg) {
    errors.push(msg);
}

/**
 * Validate a batch body against the live pricing and the models live nodes
 * serve. Returns { ok, value: { model, price, items } } or { ok:false, status, errors }.
 * Each item: { idx, custom_id, messages, max_tokens, input_tokens, max_cost_micro }.
 */
export function validateBatch(body, { pricing, sellable }) {
    const errors = [];
    const b = body && typeof body === "object" ? body : {};
    if (!pricing?.enabled) return { ok: false, status: 503, errors: ["paid batch inference is paused"] };
    const model = typeof b.model === "string" ? b.model.trim() : "";
    const price = model ? modelPriceMicro(pricing, model) : null;
    if (!model) return { ok: false, status: 400, errors: ["model is required"] };
    if (!price) return { ok: false, status: 400, errors: [`model "${model}" is not sold for batch inference`], sellable: sellableList(pricing, sellable) };
    if (!sellable?.has?.(model)) return { ok: false, status: 409, errors: [`no live node serves "${model}" right now`], sellable: sellableList(pricing, sellable) };
    const items = Array.isArray(b.items) ? b.items : null;
    if (!items || items.length === 0) return { ok: false, status: 400, errors: ["items must be a non-empty array"] };
    if (items.length > pricing.max_items_per_batch) {
        return { ok: false, status: 400, errors: [`at most ${pricing.max_items_per_batch} items per batch`] };
    }
    const seen = new Set();
    const out = [];
    items.forEach((it, idx) => {
        const at = `items[${idx}]`;
        const id = typeof it?.custom_id === "string" ? it.custom_id : "";
        if (!id || id.length > 64) err(errors, `${at}.custom_id must be a string of 1-64 characters`);
        else if (seen.has(id)) err(errors, `${at}.custom_id "${id}" is repeated`);
        seen.add(id);
        const msgs = it?.messages;
        if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > MAX_MESSAGES_PER_ITEM) {
            err(errors, `${at}.messages must be 1-${MAX_MESSAGES_PER_ITEM} messages`);
            return;
        }
        if (!msgs.every((m) => m && ROLES.has(m.role) && typeof m.content === "string")) {
            err(errors, `${at}.messages: each needs role system|user|assistant and string content`);
            return;
        }
        const chars = messagesChars(msgs);
        if (chars > MAX_ITEM_CHARS) err(errors, `${at}.messages: at most ${MAX_ITEM_CHARS} characters`);
        const maxTokens = it?.max_tokens;
        if (!Number.isInteger(maxTokens) || maxTokens < 1) err(errors, `${at}.max_tokens must be a whole number >= 1`);
        else if (maxTokens > pricing.max_tokens_cap) err(errors, `${at}.max_tokens above the ${pricing.max_tokens_cap} cap`);
        const t = it?.temperature;
        if (t !== undefined && !(typeof t === "number" && t >= 0 && t <= 2)) err(errors, `${at}.temperature must be 0-2`);
        if (errors.length) return;
        const inputTokens = estimateTokensFromChars(chars);
        out.push({
            idx,
            custom_id: id,
            messages: msgs.map((m) => ({ role: m.role, content: m.content })),
            max_tokens: maxTokens,
            ...(t === undefined ? {} : { temperature: t }),
            input_tokens: inputTokens,
            max_cost_micro: itemMaxCostMicro({ inputTokens, maxTokens, ...price })
        });
    });
    if (errors.length) return { ok: false, status: 400, errors: errors.slice(0, 20) };
    return { ok: true, value: { model, price, items: out } };
}

function sellableList(pricing, sellable) {
    return Object.keys(pricing?.models ?? {}).filter((m) => sellable?.has?.(m));
}

export function totalMaxMicro(items) {
    return items.reduce((a, it) => a + Number(it.max_cost_micro), 0);
}

/** The public quote: per-item and total max cost. */
export function quoteView({ id, model, price, items, expiresAt }) {
    return {
        quote_id: id,
        model,
        price: {
            input_per_m_usd: microToUsd(price.input_micro_per_m),
            output_per_m_usd: microToUsd(price.output_micro_per_m)
        },
        item_count: items.length,
        estimated_input_tokens: items.reduce((a, it) => a + it.input_tokens, 0),
        max_output_tokens: items.reduce((a, it) => a + it.max_tokens, 0),
        total_max_cost_usd: microToUsd(totalMaxMicro(items)),
        items: items.map((it) => ({
            custom_id: it.custom_id,
            estimated_input_tokens: it.input_tokens,
            max_tokens: it.max_tokens,
            max_cost_usd: microToUsd(it.max_cost_micro)
        })),
        expires_at: expiresAt,
        token_counts: "server-side estimates: ceil(characters / 4); provider-reported counts are not used for billing"
    };
}

/** Validate a top-up amount: whole cents, min..MAX_TOPUP_USD. */
export function parseTopupAmount(v, minUsd) {
    const micro = usdToMicro(typeof v === "number" ? v : String(v ?? ""));
    if (micro === null || micro % 10_000 !== 0) return { ok: false, error: "amount_usd must be a USD amount in whole cents" };
    if (micro < usdToMicro(minUsd)) return { ok: false, error: `the minimum top-up is $${minUsd}` };
    if (micro > MAX_TOPUP_USD * MICRO) return { ok: false, error: `the maximum top-up is $${MAX_TOPUP_USD}` };
    return { ok: true, micro, usd: microToUsd(micro).replace(/0000$/, "") };
}

/**
 * Pure mirror of the SQL ledger functions, for unit tests and to document
 * them: hold, settle (charge + release), topup, over an account
 * { balance, held }. Each throws or returns the new state; never mutates.
 * The real ones run under a row lock in Postgres.
 */
export const ledger = {
    available: (a) => a.balance - a.held,
    topup: (a, amount) => ({ ...a, balance: a.balance + amount }),
    hold(a, amount) {
        if (a.balance - a.held < amount) return { ok: false, account: a, reason: "insufficient_balance" };
        return { ok: true, account: { ...a, held: a.held + amount } };
    },
    settle(a, { maxCost, cost, completed }) {
        const charge = completed ? Math.min(Math.max(cost, 0), maxCost) : 0;
        return { charge, release: maxCost - charge, account: { balance: a.balance - charge, held: a.held - maxCost } };
    }
};

/** Status counts for a list of items. */
export function itemCounts(items) {
    const c = { total: 0, queued: 0, dispatched: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const it of items ?? []) {
        c.total += 1;
        if (it.status in c) c[it.status] += 1;
    }
    return c;
}

/** Receipt totals for a batch and its items. providerMicro: sum of provider earnings (micro). */
export function buildReceipt({ batch, items, providerMicro = null }) {
    const done = (items ?? []).filter((i) => i.settled_at);
    const completed = done.filter((i) => i.status === "completed");
    const charged = Number(batch.charged_micro) || 0;
    const provider = providerMicro === null
        ? providerSplitMicro(charged, batch.house_fee_pct).providerMicro
        : Math.min(providerMicro, charged);
    return {
        batch_id: batch.id,
        model: batch.model,
        status: batch.status,
        items: itemCounts(items),
        estimated_input_tokens: completed.reduce((a, i) => a + (Number(i.input_tokens) || 0), 0),
        estimated_output_tokens: completed.reduce((a, i) => a + (Number(i.output_tokens) || 0), 0),
        price: {
            input_per_m_usd: microToUsd(batch.input_micro_per_m),
            output_per_m_usd: microToUsd(batch.output_micro_per_m)
        },
        max_cost_usd: microToUsd(batch.max_cost_micro),
        held_usd: microToUsd(batch.hold_micro),
        total_charged_usd: microToUsd(charged),
        released_usd: microToUsd(batch.released_micro),
        provider_share_usd: microToUsd(provider),
        platform_fee_usd: microToUsd(charged - provider),
        house_fee_pct: Number(batch.house_fee_pct),
        created_at: batch.created_at,
        cancelled_at: batch.cancelled_at ?? null,
        completed_at: batch.completed_at ?? null,
        funding: fundingBreakdown(batch),
        token_counts: "server-side estimates: ceil(characters / 4)"
    };
}

// ---- funding sources ------------------------------------------------------
//
// A batch hold is covered from these, in order (account setting
// funding_order, or the request's `funding`):
//   earned   the user's confirmed node earnings (Infernet and c0mpute nodes
//            share one earnings balance), moved into the compute balance at
//            submit with no fee; unused funds go back at batch end
//   prepaid  CoinPay top-ups already in the compute balance
//   wallet   pay the shortfall for this batch: x402 (USDC) in the same
//            request, or a CoinPay checkout to pay and resubmit

export const FUNDING_SOURCES = ["earned", "prepaid", "wallet"];
export const DEFAULT_FUNDING_ORDER = ["earned", "prepaid", "wallet"];
export const FUNDING_PRESETS = {
    earned_first: ["earned", "prepaid", "wallet"],
    prepaid_first: ["prepaid", "earned", "wallet"],
    earned_only: ["earned"],
    prepaid_only: ["prepaid"],
    no_wallet: ["earned", "prepaid"]
};

/** An explicit list of distinct known sources, or null. */
export function cleanFundingOrder(v) {
    if (!Array.isArray(v) || v.length === 0 || v.length > FUNDING_SOURCES.length) return null;
    if (!v.every((s) => FUNDING_SOURCES.includes(s))) return null;
    if (new Set(v).size !== v.length) return null;
    return [...v];
}

/**
 * The sources for one submit: the request's `funding` (a preset name or a
 * list) else the account's funding_order else the default.
 * Returns { ok, sources } or { ok:false, error }.
 */
export function parseFunding(requested, accountOrder) {
    if (requested === undefined || requested === null || requested === "") {
        return { ok: true, sources: cleanFundingOrder(accountOrder) ?? [...DEFAULT_FUNDING_ORDER] };
    }
    if (typeof requested === "string" && FUNDING_PRESETS[requested]) return { ok: true, sources: [...FUNDING_PRESETS[requested]] };
    const list = cleanFundingOrder(requested);
    if (list) return { ok: true, sources: list };
    return { ok: false, error: `funding must be one of ${Object.keys(FUNDING_PRESETS).join(", ")} or a list of ${FUNDING_SOURCES.join(", ")}` };
}

/**
 * Mirror of the plan inference_submit_batch makes under its locks: how much
 * of `total` each source covers, and the shortfall left. prepaid is the
 * compute balance; wallet is only what this request's own wallet payment
 * (walletMicro, already credited to the balance) added.
 */
export function planFunding({ sources, totalMicro, earnedMicro, prepaidMicro, walletMicro = 0 }) {
    let need = Number(totalMicro);
    const balance = Math.max(0, Number(prepaidMicro) || 0);
    const wallet = Math.min(Math.max(0, Number(walletMicro) || 0), balance);
    const plan = { earned: 0, prepaid: 0, wallet: 0 };
    for (const s of sources) {
        if (need <= 0) break;
        let take = 0;
        if (s === "earned") take = Math.min(need, Math.max(0, Number(earnedMicro) || 0));
        else if (s === "prepaid") take = Math.min(need, balance - wallet);
        else if (s === "wallet") take = Math.min(need, wallet);
        plan[s] += take;
        need -= take;
    }
    return { ...plan, shortfall: need, walletAllowed: sources.includes("wallet") };
}

/** Whole cents a wallet payment must cover for a shortfall (rounded up). */
export function shortfallCents(micro) {
    return Number(ceilDiv(BigInt(Math.max(0, Math.floor(Number(micro) || 0))), 10_000n));
}

/** Which source paid a batch: charges use the earned part first. */
export function fundingBreakdown(batch) {
    const hold = Number(batch.hold_micro) || 0;
    const earned = Number(batch.funded_earned_micro) || 0;
    const wallet = Math.min(Number(batch.funded_wallet_micro) || 0, hold - earned);
    const charged = Number(batch.charged_micro) || 0;
    const paidEarned = Math.min(charged, earned);
    const paidWallet = Math.min(charged - paidEarned, wallet);
    return {
        sources: batch.funding ?? DEFAULT_FUNDING_ORDER,
        held_from: {
            earned_usd: microToUsd(earned),
            wallet_usd: microToUsd(wallet),
            prepaid_usd: microToUsd(hold - earned - wallet)
        },
        paid_from: {
            earned_usd: microToUsd(paidEarned),
            wallet_usd: microToUsd(paidWallet),
            prepaid_usd: microToUsd(charged - paidEarned - paidWallet)
        },
        returned_to_earnings_usd: microToUsd(batch.returned_earned_micro ?? 0)
    };
}
