import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { refundsDue, markRefunded } from "@/lib/data/reservation-orders";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/admin/orders/refunds → paid orders that could not be booked (refund_state = due)
 * POST /api/v1/admin/orders/refunds  { order_id, note }  → mark one refunded (note = tx hash or how)
 * Refunds are paid by hand; this is the queue and the record.
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    const due = await refundsDue();
    return ok({
        count: due.length,
        total_usd: Math.round(due.reduce((s, o) => s + o.total_usd, 0) * 100) / 100,
        orders: due.map((o) => ({
            id: o.id, rail: o.rail, total_usd: o.total_usd, payer: o.payer, email: o.email,
            payment_ref: o.payment_ref, paid_at: o.paid_at, error: o.error, created_at: o.created_at
        }))
    });
}

export async function POST(request) {
    const { actor, error } = await requireAdmin(request);
    if (error) return error;
    const body = await request.json().catch(() => ({}));
    try {
        const order = await markRefunded(String(body?.order_id ?? ""), { note: body?.note, actor });
        return ok({ id: order.id, refund_state: order.refund_state, refund_note: order.refund_note });
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
