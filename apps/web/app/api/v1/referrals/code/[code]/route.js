import { NextResponse } from "next/server";
import { lookupCode } from "@/lib/data/referrals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/referrals/code/<code>: whether it exists, plus the public terms. Never who owns it. */
export async function GET(_request, { params }) {
    const { code } = await params;
    try {
        const out = await lookupCode(code);
        return NextResponse.json({ data: out }, { status: out.valid ? 200 : 404, headers: { "cache-control": "public, max-age=60" } });
    } catch (err) {
        console.error("[referrals] lookup failed", err?.message ?? err);
        return NextResponse.json({ error: "lookup unavailable" }, { status: 503 });
    }
}
