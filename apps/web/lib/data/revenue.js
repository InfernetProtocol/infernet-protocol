import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getEarningsConfig } from "@/lib/data/earnings";
import { summariseRevenue } from "@/lib/earnings/revenue";

/** Revenue analytics rows for a window (aggregation in lib/earnings/revenue.js). */

function withStatus(message, status) {
    return Object.assign(new Error(message), { status });
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

function list(v) {
    return String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Our own emails and payer addresses: orders from them are internal usage. */
export function internalBuyers(env = process.env) {
    return {
        emails: [...list(env.INFERNET_ADMIN_EMAILS), ...list(env.INFERNET_INTERNAL_EMAILS)],
        payers: list(env.INFERNET_INTERNAL_PAYERS)
    };
}

export function revenueWindow({ from, to } = {}, now = Date.now()) {
    const end = to ? new Date(to) : new Date(now);
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw withStatus("from and to must be ISO dates", 400);
    if (start >= end) throw withStatus("from must be before to", 400);
    return { from: start.toISOString(), to: end.toISOString() };
}

export async function getRevenue(params = {}) {
    const { from, to } = revenueWindow(params);
    const db = getSupabaseServerClient();
    const [orders, jobs, payouts, subsidy, config] = await Promise.all([
        selectAll(() => db.from("reservation_orders")
            .select("id, status, provider_id, total_usd, setup_fee, refund_state, email, payer, reservation_id, paid_at")
            .not("paid_at", "is", null).gte("paid_at", from).lt("paid_at", to).order("paid_at")),
        selectAll(() => db.from("jobs")
            .select("id, provider_id, payment_offer")
            .eq("payment_status", "confirmed").gt("payment_offer", 0)
            .gte("completed_at", from).lt("completed_at", to).order("completed_at")),
        selectAll(() => db.from("payout_requests")
            .select("id, amount_usd")
            .eq("status", "sent").gte("sent_at", from).lt("sent_at", to).order("sent_at")),
        selectAll(() => db.from("provider_earnings")
            .select("amount_usd, status")
            .eq("kind", "subsidy").gte("earned_at", from).lt("earned_at", to).order("earned_at")),
        getEarningsConfig(db)
    ]);
    const reservationIds = orders.map((o) => o.reservation_id).filter(Boolean);
    const jobIds = jobs.map((j) => j.id);
    const earnings = [];
    for (let i = 0; i < reservationIds.length; i += 200) {
        const { data, error } = await db.from("provider_earnings").select("kind, job_id, reservation_id, amount_usd, fee_usd, status")
            .eq("kind", "reservation").in("reservation_id", reservationIds.slice(i, i + 200));
        if (error) throw withStatus(error.message, 500);
        earnings.push(...(data ?? []));
    }
    for (let i = 0; i < jobIds.length; i += 200) {
        const { data, error } = await db.from("provider_earnings").select("kind, job_id, reservation_id, amount_usd, fee_usd, status")
            .eq("kind", "paid").in("job_id", jobIds.slice(i, i + 200));
        if (error) throw withStatus(error.message, 500);
        earnings.push(...(data ?? []));
    }
    return {
        from,
        to,
        currency: "USD",
        ...summariseRevenue({
            orders: orders.map((o) => ({ ...o, total_usd: Number(o.total_usd), setup_fee: Number(o.setup_fee) })),
            jobs,
            earnings,
            payouts,
            subsidy,
            config,
            internal: internalBuyers()
        })
    };
}
