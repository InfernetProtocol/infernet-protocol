import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { encryptJSON, decryptJSON } from "@/lib/encrypt";
import {
    sha256, newReservationKey, newBuyerToken, minuteFloor, windowOf,
    buildReport, buildInvoice, publicReservation
} from "@/lib/reservations/core";

/**
 * Managed endpoints / reservations — database access. See
 * docs/prd/16-managed-endpoints.md. All writes go through the service-role
 * client; nothing here is reachable without an admin bearer, a reservation
 * key or the buyer's buyer token (checked by the route handlers).
 */

const COLUMNS = "id, name, buyer, operator_name, target_kind, provider_id, endpoint_url, endpoint_secret, models, start_at, hours, included_tokens, per_key_rps, per_key_concurrency, shared_rps, shared_concurrency, required_minutes_per_hour, probe_completion, currency, price_per_hour, gpu_class, setup_fee, status, buyer_token_hash, tokens_used, created_by, notes, created_at, updated_at";

function db() {
    return getSupabaseServerClient();
}

function normalize(row) {
    if (!row) return null;
    return {
        ...row,
        included_tokens: Number(row.included_tokens ?? 0),
        tokens_used: Number(row.tokens_used ?? 0),
        price_per_hour: row.price_per_hour === null || row.price_per_hour === undefined ? null : Number(row.price_per_hour),
        setup_fee: row.setup_fee === null || row.setup_fee === undefined ? null : Number(row.setup_fee)
    };
}

export async function createReservation(value, { createdBy } = {}) {
    if (value.target_kind === "node") {
        const { data: node, error } = await db().from("providers").select("id, name").eq("id", value.provider_id).maybeSingle();
        if (error) throw error;
        if (!node) {
            const e = new Error(`provider ${value.provider_id} not found`);
            e.status = 400;
            throw e;
        }
    }
    const report = newBuyerToken();
    const row = {
        name: value.name,
        buyer: value.buyer,
        operator_name: value.operator_name,
        target_kind: value.target_kind,
        provider_id: value.provider_id,
        endpoint_url: value.endpoint_url,
        endpoint_secret: value.endpoint_api_key ? encryptJSON({ apiKey: value.endpoint_api_key }) : null,
        models: value.models,
        start_at: value.start_at,
        hours: value.hours,
        included_tokens: value.included_tokens,
        per_key_rps: value.per_key_rps,
        per_key_concurrency: value.per_key_concurrency,
        shared_rps: value.shared_rps,
        shared_concurrency: value.shared_concurrency,
        required_minutes_per_hour: value.required_minutes_per_hour,
        probe_completion: value.probe_completion,
        currency: value.currency,
        price_per_hour: value.price_per_hour,
        gpu_class: value.gpu_class ?? null,
        setup_fee: value.setup_fee ?? null,
        notes: value.notes,
        buyer_token_hash: report.hash,
        created_by: createdBy ?? null
    };
    const { data, error } = await db().from("reservations").insert(row).select(COLUMNS).single();
    if (error) throw error;
    return { reservation: normalize(data), buyerToken: report.token };
}

export async function listReservations({ limit = 50 } = {}) {
    const { data, error } = await db().from("reservations").select(COLUMNS)
        .order("start_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map(normalize);
}

export async function getReservation(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ""))) return null;
    const { data, error } = await db().from("reservations").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw error;
    return normalize(data);
}

/** Fields that may change after creation. Window, target and models are fixed. */
const MUTABLE = new Set(["name", "buyer", "notes", "price_per_hour", "setup_fee", "currency", "status"]);

export async function updateReservation(id, patch) {
    const row = {};
    for (const [k, v] of Object.entries(patch ?? {})) if (MUTABLE.has(k)) row[k] = v;
    if (row.status && !["scheduled", "cancelled"].includes(row.status)) {
        const e = new Error("status must be scheduled or cancelled");
        e.status = 400;
        throw e;
    }
    for (const k of ["price_per_hour", "setup_fee"]) {
        if (!(k in row) || row[k] === null) continue;
        const p = Number(row[k]);
        if (!Number.isFinite(p) || p < 0) {
            const e = new Error(`${k} must be a non-negative number or null`);
            e.status = 400;
            throw e;
        }
        row[k] = p;
    }
    if (Object.keys(row).length === 0) return getReservation(id);
    row.updated_at = new Date().toISOString();
    const { data, error } = await db().from("reservations").update(row).eq("id", id).select(COLUMNS).maybeSingle();
    if (error) throw error;
    return normalize(data);
}

export async function rotateBuyerToken(id) {
    const report = newBuyerToken();
    const { error } = await db().from("reservations").update({ buyer_token_hash: report.hash }).eq("id", id);
    if (error) throw error;
    return report.token;
}

export function buyerTokenMatches(res, token) {
    return Boolean(res && token && sha256(token) === res.buyer_token_hash);
}

// ---- keys ------------------------------------------------------------------

export async function issueKey(reservationId, { label } = {}) {
    const k = newReservationKey();
    const { data, error } = await db().from("reservation_keys")
        .insert({ reservation_id: reservationId, label: label ?? null, key_prefix: k.prefix, key_hash: k.hash })
        .select("id, reservation_id, label, key_prefix, revoked_at, created_at").single();
    if (error) throw error;
    return { ...data, key: k.key };
}

export async function listKeys(reservationId) {
    const { data, error } = await db().from("reservation_keys")
        .select("id, reservation_id, label, key_prefix, revoked_at, created_at")
        .eq("reservation_id", reservationId).order("created_at");
    if (error) throw error;
    return data ?? [];
}

export async function revokeKey(reservationId, keyId) {
    const { data, error } = await db().from("reservation_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("reservation_id", reservationId).eq("id", keyId).is("revoked_at", null)
        .select("id, label, key_prefix, revoked_at").maybeSingle();
    if (error) throw error;
    return data;
}

/** Resolve a presented reservation key to { key, reservation } or null. */
export async function resolveKey(rawKey) {
    const { data: key, error } = await db().from("reservation_keys")
        .select("id, reservation_id, label, revoked_at").eq("key_hash", sha256(rawKey)).maybeSingle();
    if (error) throw error;
    if (!key || key.revoked_at) return null;
    const reservation = await getReservation(key.reservation_id);
    return reservation ? { key, reservation } : null;
}

export function endpointApiKey(res) {
    if (!res?.endpoint_secret) return null;
    try { return decryptJSON(res.endpoint_secret)?.apiKey ?? null; } catch { return null; }
}

// ---- usage + probes --------------------------------------------------------

export async function recordUsage(row) {
    const { error } = await db().from("reservation_usage").insert({
        reservation_id: row.reservation_id,
        key_id: row.key_id ?? null,
        model: row.model ?? null,
        outcome: row.outcome,
        limit_scope: row.limit_scope ?? null,
        prompt_tokens: row.prompt_tokens ?? 0,
        completion_tokens: row.completion_tokens ?? 0,
        tokens_estimated: Boolean(row.tokens_estimated),
        latency_ms: row.latency_ms ?? null,
        http_status: row.http_status ?? null
    });
    if (error) console.error("[reservations] usage insert failed:", error.message);
}

export async function addTokens(reservationId, tokens) {
    const { data, error } = await db().rpc("reservation_add_tokens", { p_reservation_id: reservationId, p_tokens: tokens });
    if (error) console.error("[reservations] token counter failed:", error.message);
    return data;
}

/** Reservations whose window covers `now` (the prober's work list). */
export async function activeReservations(now = new Date()) {
    // Windows are at most 720h, so anything that started more than 30 days ago is over.
    const since = new Date(now.getTime() - 721 * 3600 * 1000).toISOString();
    const { data, error } = await db().from("reservations").select(COLUMNS)
        .eq("status", "scheduled").lte("start_at", now.toISOString()).gte("start_at", since);
    if (error) throw error;
    return (data ?? []).map(normalize).filter((r) => now.getTime() < windowOf(r).end);
}

export async function recordProbe(reservationId, minute, { ok, latency_ms, detail }) {
    const { error } = await db().from("reservation_probes").upsert({
        reservation_id: reservationId,
        minute: minuteFloor(minute).toISOString(),
        ok: Boolean(ok),
        latency_ms: Number.isFinite(latency_ms) ? Math.round(latency_ms) : null,
        detail: detail ? String(detail).slice(0, 500) : null,
        probed_at: new Date().toISOString()
    }, { onConflict: "reservation_id,minute", ignoreDuplicates: true });
    if (error) throw error;
}

async function pageAll(build) {
    const out = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
        const { data, error } = await build().range(from, from + size - 1);
        if (error) throw error;
        out.push(...(data ?? []));
        if (!data || data.length < size) return out;
    }
}

export async function reportFor(res, now = Date.now()) {
    const { start, end } = windowOf(res);
    const s = new Date(start).toISOString();
    const e = new Date(end).toISOString();
    const [probes, usage] = await Promise.all([
        pageAll(() => db().from("reservation_probes").select("minute, ok, latency_ms, detail")
            .eq("reservation_id", res.id).gte("minute", s).lt("minute", e).order("minute")),
        pageAll(() => db().from("reservation_usage").select("at, outcome, limit_scope, prompt_tokens, completion_tokens, key_id")
            .eq("reservation_id", res.id).gte("at", s).lt("at", e).order("at"))
    ]);
    return { report: buildReport(res, probes, usage, now), probes };
}

export async function invoiceFor(res, now = Date.now()) {
    const { report } = await reportFor(res, now);
    return buildInvoice(res, report);
}

export { publicReservation };
