import { NextResponse } from "next/server";

import { handleRoute } from "@/lib/http";
import { verifySignedNextRequest, parseJsonBody } from "@/lib/auth/verify-signed-request";
import { getEarningsForNode } from "@/lib/data/earnings";

/**
 * POST /api/v1/node/earnings  (signed by the node)
 * Body: { recent?: number }
 * → { provider_id, balance, recent, payouts, config }
 */
export async function POST(request) {
    return handleRoute(async () => {
        const { pubkey, body } = await verifySignedNextRequest(request);
        const json = parseJsonBody(body);
        const result = await getEarningsForNode({ pubkey, recent: json.recent ?? json.limit });
        return NextResponse.json({ data: result });
    });
}
