import { NextResponse } from "next/server";
import { pickChatProvider } from "@/lib/data/chat";
import { matchServedModel } from "@/lib/model-names";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 60 });

function err(status, error) {
    return NextResponse.json({ error }, { status });
}

/**
 * GET /api/chat/provider?modelName=qwen2.5:7b&exclude=<provider id>
 *
 * Pre-select a provider and return its public key so the client can
 * derive the NIP-44 shared secret before encrypting the prompt (IPIP-0027).
 * The reservation window is handled by the client doing the POST to
 * /api/chat within a reasonable time — no server-side lock needed for v1.
 */
export async function GET(request) {
    const ip = getClientIp(request);
    const r = limit.check(ip);
    if (!r.ok) return err(429, "Rate limit exceeded");

    const { searchParams } = new URL(request.url);
    const modelName = searchParams.get("modelName") ?? undefined;
    const excludeProviderIds = searchParams.getAll("exclude").slice(0, 8);

    let provider;
    try {
        provider = await pickChatProvider({ modelName, requireE2E: true, excludeProviderIds });
    } catch (e) {
        return err(500, e?.message ?? String(e));
    }

    if (!provider) {
        return NextResponse.json(
            { error: "No E2E-capable providers available", hint: "Providers must advertise NIP-44 support and a key for the requested model." },
            { status: 503 }
        );
    }

    const providerPubkey = provider.public_key ?? null;
    // IPIP-0028: prefer model-specific key so consumers encrypt to the model,
    // not the node. Falls back to null (client uses providerPubkey instead).
    const servedName = modelName ? (matchServedModel(provider.specs?.served_models, modelName) ?? modelName) : null;
    const modelPubkey = servedName ? (provider.specs?.model_keys?.[servedName] ?? null) : null;

    // Only explicitly advertised, upgraded NIP-44 daemons can be selected.
    // A Nostr identity alone does not prove that a daemon can decrypt jobs.
    const e2eCapable = provider.specs?.e2e_capable === true;
    const e2eVersion = provider.specs?.e2e_version ?? null;

    return NextResponse.json({
        providerId: provider.id,
        providerPubkey,
        modelPubkey,
        e2eCapable,
        e2eVersion,
        providerName: provider.name ?? provider.node_id ?? null,
        model: modelName ?? null,
        reservedUntil: new Date(Date.now() + 30_000).toISOString()
    });
}
