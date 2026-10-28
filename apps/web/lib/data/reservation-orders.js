import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { createReservation, issueKey, publicReservation, getReservation } from "@/lib/data/reservations";
import { newBuyerToken, sha256 } from "@/lib/reservations/core";
import { reservationFromOrder } from "@/lib/reservations/orders";
import { isSaladClass } from "@/lib/reservations/salad";
import { createOrderGroup } from "@/lib/data/salad";
import { randomBytes } from "node:crypto";

/**
 * Self-serve reservation orders — database access
 * (docs/prd/16-managed-endpoints.md, "Self-serve orders").
 *
 * An unpaid checkout order holds its node for HOLD_MS, so two buyers paying at
 * once cannot both be sold the same hours.
 */

export const HOLD_MS = 90 * 60 * 1000;

const COLUMNS = "id, status, rail, gpu_class, models, provider_id, operator_name, start_at, hours, price_per_hour, setup_fee, total_usd, name, email, buyer_token_hash, payment_ref, payer, reservation_id, error, salad_group, salad_state, created_at, paid_at, updated_at";
const PROVIDER_COLUMNS = "id, name, status, last_seen, reputation, gpu_model, specs, trust_tier";

function db() {
    return getSupabaseServerClient();
}

function normalize(row) {
    if (!row) return null;
    return {
        ...row,
        price_per_hour: Number(row.price_per_hour),
        setup_fee: Number(row.setup_fee),
        total_usd: Number(row.total_usd)
    };
}

/** Providers seen in the last few minutes, the only ones worth matching. */
export async function onlineProviders(now = Date.now()) {
    const since = new Date(now - 5 * 60 * 1000).toISOString();
    let q = await db().from("providers").select(PROVIDER_COLUMNS).eq("status", "available").gte("last_seen", since);
    if (q.error && /trust_tier/.test(q.error.message ?? "")) {
        q = await db().from("providers").select(PROVIDER_COLUMNS.replace(", trust_tier", "")).eq("status", "available").gte("last_seen", since);
    }
    if (q.error) throw q.error;
    return q.data ?? [];
}

/** Every booking that can still overlap a new order: live reservations and held orders. */
export async function bookings(now = Date.now()) {
    const since = new Date(now - 169 * 3600 * 1000).toISOString();
    const [res, ord] = await Promise.all([
        db().from("reservations").select("provider_id, start_at, hours").eq("status", "scheduled")
            .eq("target_kind", "node").gte("start_at", since),
        db().from("reservation_orders").select("provider_id, start_at, hours").eq("status", "awaiting_payment")
            .gte("created_at", new Date(now - HOLD_MS).toISOString())
    ]);
    if (res.error) throw res.error;
    if (ord.error) throw ord.error;
    return [...(res.data ?? []), ...(ord.data ?? [])].filter((b) => b.provider_id);
}

/**
 * Record an order. Returns { order, buyerToken }; the token is shown once and
 * reads the order and, once paid, the reservation.
 */
/** Salad orders have no node: provider is null and the operator is us, on SaladCloud. */
export async function placeOrder({ value, quote, provider, rail, paymentRef = null, payer = null }) {
    const token = newBuyerToken();
    const row = {
        status: "awaiting_payment",
        rail,
        gpu_class: value.gpu_class,
        models: value.models,
        provider_id: provider ? provider.id : null,
        operator_name: provider ? (provider.name || `node ${provider.id}`) : "Infernet on SaladCloud",
        start_at: value.start_at,
        hours: value.hours,
        price_per_hour: quote.price_per_hour,
        setup_fee: quote.setup_fee,
        total_usd: quote.total_usd,
        name: value.name || `${quote.label} x ${value.hours}h`,
        email: value.email,
        buyer_token_hash: token.hash,
        payment_ref: paymentRef,
        payer,
        paid_at: paymentRef && rail === "x402" ? new Date().toISOString() : null
    };
    const { data, error } = await db().from("reservation_orders").insert(row).select(COLUMNS).single();
    if (error) throw error;
    return { order: normalize(data), buyerToken: token.token };
}

export async function setPaymentRef(id, paymentRef) {
    const { error } = await db().from("reservation_orders").update({ payment_ref: paymentRef, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw error;
}

export async function getOrder(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ""))) return null;
    const { data, error } = await db().from("reservation_orders").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw error;
    return normalize(data);
}

export async function orderByPaymentRef(refs) {
    const list = (Array.isArray(refs) ? refs : [refs]).filter(Boolean).map(String);
    if (list.length === 0) return null;
    const { data, error } = await db().from("reservation_orders").select(COLUMNS).in("payment_ref", list).limit(1).maybeSingle();
    if (error) throw error;
    return normalize(data);
}

export function orderTokenMatches(order, token) {
    return Boolean(order && typeof token === "string" && token && sha256(token) === order.buyer_token_hash);
}

/**
 * Turn a paid order into its reservation, exactly once. The status flip is the
 * lock: whoever moves the row off awaiting_payment creates the reservation, so
 * the webhook and a polling buyer racing each other cannot book it twice.
 * With `withKey`, the first API key is issued and returned (the x402 path,
 * where the response is the only thing the agent gets back).
 */
export async function fulfilOrder(order, { withKey = false, payer = null } = {}) {
    const now = new Date().toISOString();
    const { data: claimed, error } = await db().from("reservation_orders")
        .update({ status: "fulfilled", paid_at: order.paid_at ?? now, payer: payer ?? order.payer ?? null, updated_at: now })
        .eq("id", order.id).eq("status", "awaiting_payment").select(COLUMNS).maybeSingle();
    if (error) throw error;
    if (!claimed) return { order: await getOrder(order.id), already: true };
    try {
        // A Salad order gets its container group now, stopped; the cron starts it an hour before start_at.
        let endpoint = null;
        if (isSaladClass(claimed.gpu_class)) {
            const apiKey = randomBytes(24).toString("base64url");
            const group = await createOrderGroup({ orderId: order.id, gpuClass: claimed.gpu_class, model: claimed.models[0], apiKey });
            await db().from("reservation_orders").update({ salad_group: group.name, salad_state: "created", updated_at: new Date().toISOString() }).eq("id", order.id);
            endpoint = { url: group.url, apiKey };
        }
        const { reservation } = await createReservation(reservationFromOrder(normalize(claimed), endpoint), {
            createdBy: `order:${order.id}`,
            buyerTokenHash: claimed.buyer_token_hash
        });
        await db().from("reservation_orders").update({ reservation_id: reservation.id, updated_at: new Date().toISOString() }).eq("id", order.id);
        const key = withKey ? await issueKey(reservation.id, { label: "first key" }) : null;
        return { order: { ...normalize(claimed), reservation_id: reservation.id }, reservation, key };
    } catch (e) {
        // Paid but not booked: keep the payment ref so it can be refunded or rebooked by hand.
        console.error(`[orders] paid order ${order.id} could not be booked: ${e?.message ?? e}`);
        await db().from("reservation_orders").update({ status: "failed", error: String(e?.message ?? e).slice(0, 500), updated_at: new Date().toISOString() }).eq("id", order.id);
        throw Object.assign(new Error("payment received but the reservation could not be created; it will be refunded or rebooked"), { status: 500 });
    }
}

/** What the buyer sees for an order. */
export async function publicOrder(order, now = Date.now()) {
    const expired = order.status === "awaiting_payment" && now - Date.parse(order.created_at) > HOLD_MS;
    const reservation = order.reservation_id ? await getReservation(order.reservation_id) : null;
    return {
        id: order.id,
        status: expired ? "expired" : order.status,
        rail: order.rail,
        gpu_class: order.gpu_class,
        models: order.models,
        provider_id: order.provider_id,
        operator_name: order.operator_name,
        start_at: order.start_at,
        hours: order.hours,
        price_per_hour: order.price_per_hour,
        setup_fee: order.setup_fee,
        total_usd: order.total_usd,
        currency: "USD",
        paid_at: order.paid_at,
        reservation_id: order.reservation_id,
        reservation: reservation ? publicReservation(reservation) : null,
        error: order.status === "failed" ? order.error : undefined,
        created_at: order.created_at
    };
}

/** Paid Salad orders whose container group still exists, for the cron. */
export async function saladOrdersToTend() {
    const { data, error } = await db().from("reservation_orders").select(COLUMNS)
        .eq("status", "fulfilled").not("salad_group", "is", null).in("salad_state", ["created", "started"]);
    if (error) throw error;
    return (data ?? []).map(normalize);
}

export async function setSaladState(id, state, err = null) {
    const patch = { salad_state: state, updated_at: new Date().toISOString() };
    if (err) patch.error = String(err).slice(0, 500);
    const { error } = await db().from("reservation_orders").update(patch).eq("id", id);
    if (error) throw error;
}
