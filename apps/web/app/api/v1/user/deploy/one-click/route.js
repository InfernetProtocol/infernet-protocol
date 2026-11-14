import { NextResponse } from "next/server";
import { handleRoute } from "@/lib/http";
import { verifyBearerHeader, issueBearer } from "@/lib/auth/bearer";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { appUrl } from "@/lib/auth/app-url";
import { rateLimit } from "@/lib/rate-limit";
import { listOffers, launch, OneClickError, ONE_CLICK_PROVIDERS } from "@/lib/deploy/one-click";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/user/deploy/one-click
 *
 * Body: { action: "offers" | "launch", provider, apiKey, offerId?, region?, model? }
 *
 * Rents a GPU on the caller's OWN cloud account (their key, their bill)
 * and boots it into an Infernet node linked to their account. The key
 * is used for this request only: never stored, never logged, never
 * echoed back. Signed-in users only (session cookie or CLI bearer).
 */
const DEPLOY_TTL_SECONDS = 24 * 60 * 60;
const offersLimit = rateLimit({ windowMs: 60_000, max: 20 });
const launchLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

async function resolveUser(request) {
    const claims = verifyBearerHeader(request.headers.get("authorization"));
    if (claims?.sub) return { userId: claims.sub, email: claims.email ?? null };
    try {
        const user = await getCurrentUser();
        if (user?.id) return { userId: user.id, email: user.email ?? null };
    } catch { /* fall through */ }
    return null;
}

export async function GET() {
    // Public: which providers support one-click, and where to mint a key.
    return NextResponse.json({
        data: Object.entries(ONE_CLICK_PROVIDERS).map(([id, p]) => ({
            id, label: p.label, keyUrl: p.keyUrl, needsKeyToList: p.needsKeyToList
        }))
    });
}

export async function POST(request) {
    return handleRoute(async () => {
        const auth = await resolveUser(request);
        if (!auth) throw new OneClickError("not signed in", 401);

        let body;
        try { body = await request.json(); } catch { throw new OneClickError("invalid JSON body"); }
        const { action, provider, apiKey, offerId, region, model } = body ?? {};
        const key = typeof apiKey === "string" ? apiKey.trim() : "";

        if (action === "offers") {
            if (!offersLimit.check(auth.userId).ok) throw new OneClickError("too many requests, try again in a minute", 429);
            const offers = await listOffers({ provider, apiKey: key });
            return NextResponse.json({ data: { provider, offers } });
        }

        if (action === "launch") {
            if (!launchLimit.check(auth.userId).ok) throw new OneClickError("launch limit reached (10/hour)", 429);
            const token = issueBearer({ userId: auth.userId, email: auth.email, ttlSeconds: DEPLOY_TTL_SECONDS });
            const params = new URLSearchParams({ token });
            if (typeof model === "string" && /^[\w.:/-]{1,120}$/.test(model)) params.set("model", model);
            const cloudInitUrl = `${appUrl().replace(/\/+$/, "")}/api/deploy/cloud-init?${params}`;
            const result = await launch({ provider, apiKey: key, offerId, region, cloudInitUrl });
            return NextResponse.json({ data: result });
        }

        throw new OneClickError("action must be 'offers' or 'launch'");
    });
}
