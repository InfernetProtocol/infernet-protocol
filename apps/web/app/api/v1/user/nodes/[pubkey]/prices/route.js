import { NextResponse } from "next/server";
import { verifyBearerHeader } from "@/lib/auth/bearer";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { userOwnsPubkey } from "@/lib/data/node-commands";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { listProviderPricing, setProviderPrice, clearProviderPrice } from "@/lib/data/operator-prices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What a node charges for the models it serves.
 *
 *   GET    /api/v1/user/nodes/<pubkey>/prices
 *     → { bounds, default_model_price, models: [{ model, input_per_m_usd,
 *         output_per_m_usd, source: "operator"|"house"|"default", house, ... }] }
 *
 *   PUT    /api/v1/user/nodes/<pubkey>/prices
 *     { model, input_per_m_usd, output_per_m_usd }   set one model's price
 *
 *   DELETE /api/v1/user/nodes/<pubkey>/prices?model=<id>
 *     drop the override, so the model falls back to the house price
 *
 * Auth: CLI bearer or the site session, and the caller must own the pubkey
 * (pubkey_links). Non-owners get 403, not 404, so a legitimate owner with a
 * typo'd pubkey still sees a useful error.
 *
 * A price outside the house band is refused, not clamped: an operator asking
 * for a price we will not honour should be told, not quietly given another.
 * (Reads clamp, so narrowing the band later still holds — see
 * lib/billing/operator-prices.js.)
 */

function fail(status, error, extra) {
    return NextResponse.json({ error, ...(extra ?? {}) }, { status, headers: { "cache-control": "no-store" } });
}

async function resolveUser(request) {
    const claims = verifyBearerHeader(request.headers.get("authorization"));
    if (claims?.sub) return claims.sub;
    try {
        const user = await getCurrentUser();
        if (user?.id) return user.id;
    } catch {
        /* fall through */
    }
    return null;
}

/** The provider row for a pubkey the caller owns, plus the models it serves. */
async function ownedProvider(request, pubkeyRaw) {
    const pubkey = typeof pubkeyRaw === "string" ? decodeURIComponent(pubkeyRaw) : "";
    if (!pubkey) return { error: fail(400, "a node pubkey is required") };

    const userId = await resolveUser(request);
    if (!userId) return { error: fail(401, "sign in first (`infernet login`, or the site)") };

    const owns = await userOwnsPubkey(userId, pubkey);
    if (!owns) return { error: fail(403, "that node is not linked to your account") };

    const { data, error } = await getSupabaseServerClient()
        .from("providers")
        .select("id, specs")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (error) return { error: fail(500, error.message) };
    if (!data) return { error: fail(404, "no provider row for that pubkey yet; register the node first") };

    const served = Array.isArray(data.specs?.served_models) ? data.specs.served_models.filter(Boolean) : [];
    return { providerId: data.id, served, userId };
}

export async function GET(request, { params }) {
    const { pubkey } = await params;
    const r = await ownedProvider(request, pubkey);
    if (r.error) return r.error;
    try {
        const out = await listProviderPricing({ providerId: r.providerId, servedModels: r.served });
        return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
    } catch (e) {
        return fail(e?.status ?? 500, e?.message ?? "could not read prices");
    }
}

export async function PUT(request, { params }) {
    const { pubkey } = await params;
    const r = await ownedProvider(request, pubkey);
    if (r.error) return r.error;

    let body;
    try {
        body = await request.json();
    } catch {
        return fail(400, "invalid JSON body");
    }

    try {
        const set = await setProviderPrice({
            providerId: r.providerId,
            model: body?.model,
            price: { input_per_m_usd: body?.input_per_m_usd, output_per_m_usd: body?.output_per_m_usd },
            actor: r.userId
        });
        return NextResponse.json(set, { headers: { "cache-control": "no-store" } });
    } catch (e) {
        return fail(e?.status ?? 500, e?.message ?? "could not set that price", e?.bounds ? { bounds: e.bounds } : undefined);
    }
}

export async function DELETE(request, { params }) {
    const { pubkey } = await params;
    const r = await ownedProvider(request, pubkey);
    if (r.error) return r.error;

    const model = new URL(request.url).searchParams.get("model");
    if (!model) return fail(400, "model is required: ?model=<id>");
    try {
        return NextResponse.json(await clearProviderPrice({ providerId: r.providerId, model }), {
            headers: { "cache-control": "no-store" }
        });
    } catch (e) {
        return fail(e?.status ?? 500, e?.message ?? "could not clear that price");
    }
}
