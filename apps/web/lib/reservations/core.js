/**
 * Managed endpoints / reservations — the pure part (docs/prd/16-managed-endpoints.md).
 *
 * Nothing here touches the database or the network, so the rules a buyer is
 * billed by (what a compliant hour is, what is owed, when a request is
 * refused) can be unit-tested and read in one place.
 */
import { createHash, randomBytes } from "node:crypto";
import { tierOf, floorPrice, setupFeeFor } from "./pricing.js";

export const KEY_PREFIX = "ifr_res_";
export const BUYER_TOKEN_PREFIX = "ifr_buy_";
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export function sha256(s) {
    return createHash("sha256").update(String(s)).digest("hex");
}

/** A new reservation API key. Only the hash is stored; the key is shown once. */
export function newReservationKey() {
    const key = KEY_PREFIX + randomBytes(24).toString("base64url");
    return { key, hash: sha256(key), prefix: key.slice(0, 12) };
}

/** The buyer's read-only token for the compliance report and invoice view. */
export function newBuyerToken() {
    const token = BUYER_TOKEN_PREFIX + randomBytes(24).toString("base64url");
    return { token, hash: sha256(token) };
}

export function isReservationKey(s) {
    return typeof s === "string" && s.startsWith(KEY_PREFIX) && s.length > KEY_PREFIX.length + 8;
}

export function bearerFrom(header) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(header ?? "").trim());
    return m ? m[1] : null;
}

function posInt(v, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Validate a create-reservation body. Returns { ok, value } or { ok:false, errors }.
 * Every limit is explicit on the record; defaults are conservative and the
 * caller is expected to pass the agreed numbers.
 */
export function validateReservationInput(body) {
    const b = body ?? {};
    const errors = [];
    const value = {};

    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) errors.push("name is required");
    value.name = name;
    value.buyer = typeof b.buyer === "string" && b.buyer.trim() ? b.buyer.trim() : null;

    const operator = typeof b.operator_name === "string" ? b.operator_name.trim() : "";
    if (!operator) errors.push("operator_name is required (the identified operator serving this reservation)");
    value.operator_name = operator;

    const models = Array.isArray(b.models) ? b.models : typeof b.models === "string" ? b.models.split(",") : [];
    value.models = [...new Set(models.map((m) => String(m).trim()).filter(Boolean))];
    if (value.models.length === 0) errors.push("models[] is required (exact model ids)");

    const hasNode = typeof b.provider_id === "string" && b.provider_id.trim() !== "";
    const hasUrl = typeof b.endpoint_url === "string" && b.endpoint_url.trim() !== "";
    if (hasNode === hasUrl) {
        errors.push("set exactly one target: provider_id (an Infernet node) or endpoint_url (an OpenAI-compatible base URL)");
    } else if (hasNode) {
        value.target_kind = "node";
        value.provider_id = b.provider_id.trim();
        value.endpoint_url = null;
    } else {
        let u = null;
        try { u = new URL(b.endpoint_url.trim()); } catch { /* reported below */ }
        if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) {
            errors.push("endpoint_url must be an http(s) URL");
        } else {
            value.target_kind = "endpoint";
            value.provider_id = null;
            value.endpoint_url = u.toString().replace(/\/+$/, "");
        }
    }
    value.endpoint_api_key = typeof b.endpoint_api_key === "string" && b.endpoint_api_key ? b.endpoint_api_key : null;

    const start = new Date(b.start_at ?? "");
    if (Number.isNaN(start.getTime())) {
        errors.push("start_at is required (ISO timestamp)");
    } else if (start.getTime() % HOUR_MS !== 0) {
        errors.push("start_at must be a whole UTC hour (e.g. 2026-10-12T15:00:00Z)");
    }
    value.start_at = Number.isNaN(start.getTime()) ? null : start.toISOString();

    const ints = {
        hours: [b.hours ?? 1, 1, 720],
        included_tokens: [b.included_tokens ?? 0, 0, Number.MAX_SAFE_INTEGER],
        per_key_rps: [b.per_key_rps ?? 1, 1, 10000],
        per_key_concurrency: [b.per_key_concurrency ?? 1, 1, 10000],
        shared_rps: [b.shared_rps ?? 5, 1, 10000],
        shared_concurrency: [b.shared_concurrency ?? 4, 1, 10000],
        required_minutes_per_hour: [b.required_minutes_per_hour ?? 60, 1, 60]
    };
    for (const [k, [v, min, max]] of Object.entries(ints)) {
        const n = posInt(v, { min, max });
        if (n === null) errors.push(`${k} must be an integer in [${min}, ${max}]`);
        value[k] = n;
    }
    if (value.per_key_rps && value.shared_rps && value.per_key_rps > value.shared_rps) {
        errors.push("per_key_rps cannot exceed shared_rps");
    }
    if (value.per_key_concurrency && value.shared_concurrency && value.per_key_concurrency > value.shared_concurrency) {
        errors.push("per_key_concurrency cannot exceed shared_concurrency");
    }

    value.probe_completion = b.probe_completion === true || b.probe_completion === "true";
    value.currency = typeof b.currency === "string" && /^[A-Z]{3,5}$/.test(b.currency) ? b.currency : "USD";
    if (b.price_per_hour === undefined || b.price_per_hour === null || b.price_per_hour === "") {
        value.price_per_hour = null;
    } else {
        const p = Number(b.price_per_hour);
        if (!Number.isFinite(p) || p < 0) errors.push("price_per_hour must be a non-negative number");
        value.price_per_hour = Number.isFinite(p) ? p : null;
    }
    if (b.gpu_class === undefined || b.gpu_class === null || b.gpu_class === "") {
        value.gpu_class = null;
    } else {
        const tier = tierOf(b.gpu_class);
        if (!tier) {
            errors.push("gpu_class must be one of l40s, a100, h100, h100x2");
            value.gpu_class = null;
        } else {
            value.gpu_class = String(b.gpu_class).trim().toLowerCase();
            if (value.price_per_hour === null) value.price_per_hour = tier.price_per_hour;
            else if (value.price_per_hour < floorPrice(tier.cost_per_hour)) {
                errors.push(`price_per_hour ${value.price_per_hour} is below the ${value.gpu_class} margin floor of ${floorPrice(tier.cost_per_hour)}`);
            }
        }
    }
    if (b.setup_fee === undefined || b.setup_fee === null || b.setup_fee === "") {
        value.setup_fee = value.gpu_class && value.price_per_hour !== null ? setupFeeFor(value.price_per_hour) : null;
    } else {
        const f = Number(b.setup_fee);
        if (!Number.isFinite(f) || f < 0) errors.push("setup_fee must be a non-negative number");
        value.setup_fee = Number.isFinite(f) ? f : null;
    }
    value.notes = typeof b.notes === "string" ? b.notes : null;

    return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function windowOf(res) {
    const start = new Date(res.start_at).getTime();
    return { start, end: start + res.hours * HOUR_MS };
}

/**
 * Where a reservation is relative to `now`: upcoming | active | ended | cancelled.
 */
export function phaseOf(res, now = Date.now()) {
    if (res.status === "cancelled") return "cancelled";
    const { start, end } = windowOf(res);
    if (now < start) return "upcoming";
    if (now >= end) return "ended";
    return "active";
}

export function minuteFloor(t) {
    return new Date(Math.floor(new Date(t).getTime() / MINUTE_MS) * MINUTE_MS);
}

/**
 * In-memory limiter for one reservation: requests-per-second (sliding 1s
 * window) and in-flight concurrency, per key and shared. One Next.js process
 * serves infernetprotocol.com, so process memory is the source of truth; a
 * multi-process deployment would move this to Redis.
 */
export function createLimiter(clock = () => Date.now()) {
    const hits = new Map();       // scopeKey -> number[] (timestamps)
    const inflight = new Map();   // scopeKey -> count

    function recent(k, now) {
        const arr = (hits.get(k) ?? []).filter((t) => now - t < 1000);
        hits.set(k, arr);
        return arr;
    }

    /**
     * Try to admit one request. On success returns { ok:true, release, headers }.
     * On refusal returns { ok:false, type, scope, limit, retryAfterMs, headers }.
     */
    function acquire(res, keyId) {
        const now = clock();
        const sk = `s:${res.id}`;
        const kk = `k:${res.id}:${keyId}`;
        const shared = recent(sk, now);
        const mine = recent(kk, now);
        const checks = [
            ["rps", "key", mine.length, res.per_key_rps, mine],
            ["rps", "shared", shared.length, res.shared_rps, shared],
            ["concurrency", "key", inflight.get(kk) ?? 0, res.per_key_concurrency, null],
            ["concurrency", "shared", inflight.get(sk) ?? 0, res.shared_concurrency, null]
        ];
        for (const [type, scope, used, limit, arr] of checks) {
            if (used >= limit) {
                const retryAfterMs = arr ? Math.max(1, 1000 - (now - arr[0])) : 1000;
                return {
                    ok: false, type, scope, limit, retryAfterMs,
                    headers: limitHeaders(res, { type, scope, limit, remaining: 0, retryAfterMs })
                };
            }
        }
        mine.push(now);
        shared.push(now);
        inflight.set(kk, (inflight.get(kk) ?? 0) + 1);
        inflight.set(sk, (inflight.get(sk) ?? 0) + 1);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            inflight.set(kk, Math.max(0, (inflight.get(kk) ?? 1) - 1));
            inflight.set(sk, Math.max(0, (inflight.get(sk) ?? 1) - 1));
        };
        return {
            ok: true,
            release,
            headers: {
                "X-RateLimit-Limit-Requests": String(res.per_key_rps),
                "X-RateLimit-Remaining-Requests": String(Math.max(0, res.per_key_rps - mine.length)),
                "X-Infernet-Shared-Limit-Requests": String(res.shared_rps),
                "X-Infernet-Shared-Remaining-Requests": String(Math.max(0, res.shared_rps - shared.length)),
                "X-Infernet-Concurrency-Limit": String(res.per_key_concurrency),
                "X-Infernet-Shared-Concurrency-Limit": String(res.shared_concurrency)
            }
        };
    }

    return { acquire };
}

/** Headers on every 429 so a reseller's client can tell which limit it hit. */
export function limitHeaders(res, { type, scope, limit, remaining = 0, retryAfterMs = 1000 }) {
    return {
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        "X-Infernet-Limit-Type": type,          // rps | concurrency | tokens
        "X-Infernet-Limit-Scope": scope,        // key | shared
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": String(remaining),
        "X-Infernet-Reservation": res.id
    };
}

export function tokenAllowanceLeft(res) {
    return Math.max(0, Number(res.included_tokens ?? 0) - Number(res.tokens_used ?? 0));
}

/** Rough token estimate when an upstream does not report usage. */
export function estimateTokens(text) {
    return Math.ceil(String(text ?? "").length / 4);
}

/**
 * Per-hour availability + usage report.
 *
 * A minute is CONFIRMED when its probe row says ok and no real request in that
 * minute failed upstream. A minute with no probe row is UNCONFIRMED — if the
 * prober did not run we cannot claim the endpoint was up. An hour is
 * compliant when confirmed minutes >= required_minutes_per_hour (60 = every
 * minute). Hours that have not finished are "pending"; they are never billed.
 *
 * @param {object} res          reservation row
 * @param {Array}  probes       [{ minute, ok, latency_ms, detail }]
 * @param {Array}  usage        [{ at, outcome, prompt_tokens, completion_tokens, key_id }]
 * @param {number} now
 */
export function buildReport(res, probes, usage, now = Date.now()) {
    const { start } = windowOf(res);
    const probeByMinute = new Map();
    for (const p of probes ?? []) probeByMinute.set(minuteFloor(p.minute).getTime(), p);
    const failedTrafficMinutes = new Set();
    for (const u of usage ?? []) {
        if (u.outcome === "upstream_error") failedTrafficMinutes.add(minuteFloor(u.at).getTime());
    }

    const hours = [];
    for (let h = 0; h < res.hours; h++) {
        const hStart = start + h * HOUR_MS;
        const hEnd = hStart + HOUR_MS;
        let confirmed = 0, failed = 0, missing = 0;
        let latencySum = 0, latencyN = 0;
        const failures = [];
        for (let m = hStart; m < hEnd; m += MINUTE_MS) {
            if (m >= now) break;
            const p = probeByMinute.get(m);
            if (!p) { missing++; continue; }
            if (p.ok && !failedTrafficMinutes.has(m)) {
                confirmed++;
                if (Number.isFinite(p.latency_ms)) { latencySum += p.latency_ms; latencyN++; }
            } else {
                failed++;
                failures.push({
                    minute: new Date(m).toISOString(),
                    reason: !p.ok ? (p.detail ?? "probe failed") : "request failed upstream"
                });
            }
        }
        const hourUsage = (usage ?? []).filter((u) => {
            const t = new Date(u.at).getTime();
            return t >= hStart && t < hEnd;
        });
        const sum = (f) => hourUsage.reduce((a, u) => a + (Number(u[f]) || 0), 0);
        const count = (o) => hourUsage.filter((u) => u.outcome === o).length;

        let status;
        if (res.status === "cancelled") status = "cancelled";
        else if (now < hEnd) status = now < hStart ? "upcoming" : "in_progress";
        else status = confirmed >= res.required_minutes_per_hour ? "compliant" : "non_compliant";

        hours.push({
            hour: h + 1,
            start: new Date(hStart).toISOString(),
            end: new Date(hEnd).toISOString(),
            status,
            minutes: { confirmed, failed, unconfirmed: missing, required: res.required_minutes_per_hour },
            avg_probe_latency_ms: latencyN ? Math.round(latencySum / latencyN) : null,
            failures,
            usage: {
                requests: hourUsage.filter((u) => u.outcome === "ok" || u.outcome === "upstream_error").length,
                ok: count("ok"),
                upstream_errors: count("upstream_error"),
                prompt_tokens: sum("prompt_tokens"),
                completion_tokens: sum("completion_tokens"),
                limit_hits: {
                    rps: count("limit_rps"),
                    concurrency: count("limit_concurrency"),
                    tokens: count("limit_tokens")
                }
            }
        });
    }

    const totals = hours.reduce((t, h) => ({
        requests: t.requests + h.usage.requests,
        prompt_tokens: t.prompt_tokens + h.usage.prompt_tokens,
        completion_tokens: t.completion_tokens + h.usage.completion_tokens,
        limit_hits: t.limit_hits + h.usage.limit_hits.rps + h.usage.limit_hits.concurrency + h.usage.limit_hits.tokens
    }), { requests: 0, prompt_tokens: 0, completion_tokens: 0, limit_hits: 0 });

    return {
        reservation_id: res.id,
        phase: phaseOf(res, now),
        generated_at: new Date(now).toISOString(),
        rule: `an hour is compliant when at least ${res.required_minutes_per_hour} of its 60 minutes are confirmed: `
            + "a successful probe of the pinned endpoint serving the exact model, and no failed request that minute. "
            + "Minutes without a probe record are unconfirmed.",
        included_tokens: Number(res.included_tokens ?? 0),
        tokens_used: Number(res.tokens_used ?? 0),
        totals,
        hours
    };
}

/**
 * Post-paid invoice data: only compliant hours are owed. Nothing is charged
 * here; this is the figure a buyer verifies before paying.
 */
export function buildInvoice(res, report) {
    const compliant = report.hours.filter((h) => h.status === "compliant").length;
    const nonCompliant = report.hours.filter((h) => h.status === "non_compliant").length;
    const open = report.hours.filter((h) => h.status === "upcoming" || h.status === "in_progress").length;
    const priced = res.price_per_hour !== null && res.price_per_hour !== undefined;
    const price = priced ? Number(res.price_per_hour) : null;
    // The setup fee covers warming the GPU, so it is owed once the
    // reservation has delivered at least one compliant hour.
    const setupFee = priced && res.setup_fee !== null && res.setup_fee !== undefined && compliant > 0
        ? Number(res.setup_fee) : 0;
    return {
        reservation_id: res.id,
        buyer: res.buyer ?? null,
        operator_name: res.operator_name,
        models: res.models,
        currency: res.currency ?? "USD",
        gpu_class: res.gpu_class ?? null,
        price_per_hour: price,
        setup_fee: priced ? setupFee : null,
        priced,
        final: open === 0,
        hours_reserved: res.hours,
        hours_compliant: compliant,
        hours_non_compliant: nonCompliant,
        hours_open: open,
        amount_due: priced ? Math.round((compliant * price + setupFee) * 100) / 100 : null,
        lines: report.hours.map((h) => ({
            hour: h.hour,
            start: h.start,
            status: h.status,
            confirmed_minutes: h.minutes.confirmed,
            amount: priced ? (h.status === "compliant" ? price : 0) : null
        })),
        note: priced
            ? "Post-paid. Only compliant hours are billable; non-compliant hours are owed nothing. No payment is collected by this system."
            : "No price has been agreed for this reservation; amount_due is null until price_per_hour is set."
    };
}

/** Public projection of a reservation row (never the secret or token hash). */
export function publicReservation(res, now = Date.now()) {
    if (!res) return null;
    // eslint-disable-next-line no-unused-vars
    const { endpoint_secret, buyer_token_hash, ...rest } = res;
    const { end } = windowOf(res);
    return {
        ...rest,
        end_at: new Date(end).toISOString(),
        phase: phaseOf(res, now),
        has_endpoint_key: Boolean(endpoint_secret),
        tokens_remaining: tokenAllowanceLeft(res)
    };
}
