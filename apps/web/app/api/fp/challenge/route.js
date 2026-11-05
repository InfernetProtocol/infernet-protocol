import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/rate-limit";
import { issueFingerprintChallenge } from "@/lib/data/fingerprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/fp/challenge — a short-lived, server-signed token for the page to
 * collect its fingerprint against (@profullstack/browser-fingerprint).
 *
 * This is the default path the package's client looks for, so the browser
 * helper needs no configuration. The token is what stops a collected payload
 * being replayed, and it is good for one submission.
 *
 * Public and unauthenticated: the free tier is for people who are not signed
 * in, so they have to be able to get one.
 */
export async function GET(request) {
    const ip = getClientIp(request);
    const token = await issueFingerprintChallenge({ ip });
    if (!token) {
        // No signing secret configured. Say so plainly rather than handing
        // back something that will not verify: the client treats a missing
        // challenge as "collect nothing" and the server falls back to the
        // address key.
        return NextResponse.json(
            { error: "fingerprint challenges are not configured here" },
            { status: 503, headers: { "cache-control": "no-store" } }
        );
    }
    return NextResponse.json({ challenge: token }, { headers: { "cache-control": "no-store" } });
}
