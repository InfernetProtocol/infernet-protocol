import { NextResponse } from "next/server";

import { handleRoute } from "@/lib/http";
import {
    verifySignedNextRequest,
    parseJsonBody
} from "@/lib/auth/verify-signed-request";
import { requeueJobForNode } from "@/lib/data/node-api";

// A node turned a chat job away (busy): back into the queue, at the back
// (lib/routing/requeue.js). CLI >= 0.1.97 calls this before failing a job.
export async function POST(request, { params }) {
    return handleRoute(async () => {
        const { pubkey, body } = await verifySignedNextRequest(request);
        const json = parseJsonBody(body);
        const { id } = await params;
        const row = await requeueJobForNode({ pubkey, jobId: id, body: json });
        return NextResponse.json({ data: row });
    });
}
