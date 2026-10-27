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
 * GET /api/chat/provider?modelName=qwen2.5:7b&minTrustTier=public
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

    let provider;
    try {
        provider = await pickChatProvider({ modelName });
    } catch (e) {
        return err(500, e?.message ?? String(e));
    }

    if (!provider) {
        return NextResponse.json(
            { error: "No providers available", hint: "Try again shortly or omit modelName to widen the pool." },
            { status: 503 }
        );
    }

    const providerPubkey = provider.public_key ?? null;
    // IPIP-0028: prefer model-specific key so consumers encrypt to the model,
    // not the node. Falls back to null (client uses providerPubkey instead).
    const servedName = modelName ? (matchServedModel(provider.specs?.served_models, modelName) ?? modelName) : null;
    const modelPubkey = servedName ? (provider.specs?.model_keys?.[servedName] ?? null) : null;

    // IPIP-0027 §7: surface E2E capability so the client knows whether
    // to encrypt and the UI can show the lock indicator. A provider with
    // a pubkey but no advertised capability still gets `e2e_capable: true`
    // — every Nostr-keyed daemon supports NIP-44.
    const e2eCapable = provider.specs?.e2e_capable === true || Boolean(providerPubkey);
    const e2eVersion = provider.specs?.e2e_version ?? (providerPubkey ? "nip44-v2" : null);

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
