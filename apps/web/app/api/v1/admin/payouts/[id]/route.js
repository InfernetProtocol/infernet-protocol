import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { approvePayoutRequest, rejectPayoutRequest, resolveSendingPayout } from "@/lib/data/earnings";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/admin/payouts/<id>
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN
 * Body: { action: "approve" }                 send it via CoinPay (real money)
 *       { action: "reject", reason? }
 *       { action: "mark_sent", tx_hash }      resolve a 'sending' one after a chain check
 *       { action: "mark_failed" }
 */
export async function POST(request, { params }) {
    const { actor, error } = requireAdmin(request);
    if (error) return error;
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    try {
        switch (body.action) {
            case "approve":
                return ok(await approvePayoutRequest(id, { actor }));
            case "reject":
                return ok(await rejectPayoutRequest(id, { actor, reason: body.reason }));
            case "mark_sent":
                return ok(await resolveSendingPayout(id, { actor, txHash: body.tx_hash ?? null }));
            case "mark_failed":
                return ok(await resolveSendingPayout(id, { actor, failed: true }));
            default:
                return fail(400, "action must be approve, reject, mark_sent or mark_failed");
        }
    } catch (err) {
        return fail(err.status ?? 500, err.message);
    }
}
