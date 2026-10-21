import { NextResponse } from "next/server";

import { handleRoute } from "@/lib/http";
import {
    verifySignedNextRequest,
    parseJsonBody
} from "@/lib/auth/verify-signed-request";
import { recordAggregatorProbes } from "@/lib/data/node-api";

/**
 * POST /api/v1/node/aggregator/probes — an aggregator reports one round of
 * provider reachability probes (apps/cli/lib/aggregator.js). Signed with the
 * aggregator's Nostr key; the key must belong to a registered aggregator.
 *
 * Body: { probes: [{ pubkey, reachable, rtt_ms, node_id, error }] }
 */
export async function POST(request) {
    return handleRoute(async () => {
        const { pubkey, body } = await verifySignedNextRequest(request);
        const json = parseJsonBody(body);
        const data = await recordAggregatorProbes({ pubkey, probes: json.probes });
        return NextResponse.json({ data });
    });
}
