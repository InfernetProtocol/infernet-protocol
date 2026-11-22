import { NextResponse } from "next/server";

import { handleRoute } from "@/lib/http";
import {
    verifySignedNextRequest,
    parseJsonBody
} from "@/lib/auth/verify-signed-request";
import { registerNode } from "@/lib/data/node-api";
import { attributeNode } from "@/lib/data/referrals";
import { getClientIp } from "@/lib/rate-limit";

const VALID_ROLES = new Set(["provider", "aggregator", "client"]);

export async function POST(request) {
    return handleRoute(async () => {
        const { pubkey, body } = await verifySignedNextRequest(request);
        const json = parseJsonBody(body);

        const role = typeof json.role === "string" ? json.role.toLowerCase() : null;
        if (!VALID_ROLES.has(role)) {
            const err = new Error(`role must be one of: ${[...VALID_ROLES].join(", ")}`);
            err.status = 400;
            throw err;
        }

        const row = await registerNode({ role, pubkey, body: json });
        // `infernet register --ref <code>`: attribute this node to a referrer.
        // Set once, at registration; a refusal never fails the registration.
        let referral;
        if (role === "provider" && typeof json.referral_code === "string" && json.referral_code.trim()) {
            try {
                referral = await attributeNode({
                    nodeKey: row.node_id,
                    code: json.referral_code,
                    via: "infernet-register",
                    ip: getClientIp(request)
                });
            } catch (err) {
                console.warn(`[referrals] attribution on register failed: ${err?.message ?? err}`);
                referral = { attributed: false, reason: "unavailable", message: "could not record the referral right now; run `infernet register --ref <code>` again later" };
            }
        }
        return NextResponse.json({ data: referral ? { ...row, referral } : row });
    });
}
