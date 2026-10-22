import { NextResponse } from "next/server";

import { handleRoute } from "@/lib/http";
import { verifySignedNextRequest, parseJsonBody } from "@/lib/auth/verify-signed-request";
import { requestPayoutForNode } from "@/lib/data/earnings";

/**
 * POST /api/v1/node/payouts/request  (signed by the node)
 * Body: { amount_usd?: number }   omitted = the whole available balance
 *
 * Queues a withdrawal for admin approval. Nothing is sent until an admin
 * approves it.
 */
export async function POST(request) {
    return handleRoute(async () => {
        const { pubkey, body } = await verifySignedNextRequest(request);
        const json = parseJsonBody(body);
        const amount = json.amount_usd == null ? null : Number(json.amount_usd);
        const result = await requestPayoutForNode({ pubkey, amountUsd: amount });
        return NextResponse.json({ data: result }, { status: 201 });
    });
}
