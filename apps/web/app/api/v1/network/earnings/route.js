import { NextResponse } from "next/server";
import { getNetworkEarnings } from "@/lib/data/infernet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/network/earnings
 *
 * Public proof that running a node pays: what nodes earned, the house fee and
 * referral commissions, all time and over the last 24h / 7d / 30d. Read
 * straight from the earnings ledger (house subsidies and voided jobs left
 * out). No node, account or wallet is named; per-node totals only feed the
 * best and median figures. c0mpute.com/status shows it next to c0mpute's own
 * job earnings. Cached 60 s.
 */
export async function GET() {
    const data = await getNetworkEarnings();
    if (!data) {
        return NextResponse.json({ error: "earnings ledger unavailable" }, { status: 503 });
    }
    return NextResponse.json(data, {
        headers: {
            "Cache-Control": "public, max-age=60, s-maxage=60",
            "Access-Control-Allow-Origin": "*"
        }
    });
}
