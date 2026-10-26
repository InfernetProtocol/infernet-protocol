import { NextResponse } from "next/server";
import { requestUser } from "@/lib/auth/request-user";
import { creditSummary } from "@/lib/credits";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/credits — the caller's consumer compute-credit balance.
 * Auth: CLI bearer (`infernet login`) or the session cookie.
 * → { unit: "credits", balance, history: [{ amount, kind, source, at }] }
 *
 * Consumer credits only: never provider earnings, never withdrawable.
 */
export async function GET(request) {
    const user = await requestUser(request);
    if (!user) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    try {
        return NextResponse.json(await creditSummary(user.id), { headers: { "cache-control": "no-store" } });
    } catch (err) {
        console.error("[credits] summary failed", err?.message ?? err);
        return NextResponse.json({ error: "credits unavailable" }, { status: 503 });
    }
}
