import { NextResponse } from "next/server";
import { createChatJob, liveModelNames } from "@/lib/data/chat";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { bearerFrom } from "@/lib/reservations/core";
import { checkChatLimit, wantsP2pOnly, trustedClientFor, paidLimit } from "@/lib/trusted-clients";
import { resolveBillingCaller, authorizeInteractive } from "@/lib/data/interactive-billing";
import { consumeFreeQuery } from "@/lib/data/free-tier";
import { freeLimitMessage } from "@/lib/billing/free-tier";
import { consumeChatRetryToken } from "@/lib/chat/retry-token";
import { requestUser } from "@/lib/auth/request-user";
import { pluginChatResponse } from "@/lib/plugins/chat-loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 20 messages per IP per hour. Good enough to keep public playground
// usable without letting a single IP burn the whole network.
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });

function err(status, error, detail) {
  const body = { error };
  if (detail !== undefined) body.detail = detail;
  return NextResponse.json(body, { status });
}

function hasEncryptedPayload(payload) {
  return typeof payload?.encryptedMessages === "string" && payload.encryptedMessages.length > 0;
}

export async function POST(request) {
  const ip = getClientIp(request);
  const bearer = bearerFrom(request.headers.get("authorization"));
  const trusted = trustedClientFor(bearer);

  // Parsed before the limiters because which limiter applies depends on who
  // pays, and that depends on the model being priced.
  let payload;
  try {
    payload = await request.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  let retryGrant = null;
  if (typeof payload?.retryToken === "string" && payload.retryToken) {
    const retry = await consumeChatRetryToken({
      token: payload.retryToken,
      ip,
      fingerprint: request.headers.get("x-fingerprint")
    });
    if (!retry.ok) return err(retry.status, retry.error);
    retryGrant = retry;
  }

  const { messages, encryptedMessages, clientPubkey, modelPubkey, providerId, modelName, maxTokens, temperature, distributed } = payload ?? {};

  // Who pays. An identified caller with something to spend (topped-up balance
  // or what their nodes earned) is billed per request and metered on the paid
  // budget instead of the stranger limit, which exists to stop one address
  // burning the network for free.
  const payer = await resolveBillingCaller(request, { trusted });
  const billing = await authorizeInteractive({ userId: payer.userId, model: modelName });

  if (billing.mode === "insufficient") {
    return err(402, "Out of compute balance", {
      spendable_usd: billing.spendable_usd,
      topUp: "POST /api/v1/billing/topup, or move node earnings in with POST /api/v1/billing/fund-from-earnings"
    });
  }

  let freeLeft;
  if (billing.mode === "balance" || billing.mode === "admin") {
    const pr = paidLimit.check(`paid:${payer.userId}`);
    if (!pr.ok) {
      return err(429, "Rate limit exceeded — try again later", {
        resetAt: new Date(pr.resetAt).toISOString()
      });
    }
  } else {
    // Free. The daily allowance is spent per consumer and counted in the
    // database, so it survives a deploy: see lib/data/free-tier.js. A trusted
    // client of ours still has its own burst budget on top, because its
    // BILLED traffic must not be held to a stranger's allowance.
    if (!retryGrant) {
      const free = await consumeFreeQuery({
        userId: payer.userId ?? null,
        clientSubject: payer.subject ?? null,
        ip,
        // Collected by the page against /api/fp/challenge.
        fingerprint: request.headers.get("x-fingerprint"),
        userAgent: request.headers.get("user-agent")
      });
      freeLeft = free.remaining;
      if (!free.ok) {
        return err(429, freeLimitMessage(free.limit, free), {
          free_limit_per_day: free.limit,
          used_today: free.used,
          resetAt: new Date(Date.now() + free.retryAfter * 1000).toISOString(),
          topUp: "POST /api/v1/billing/topup, or move node earnings in with POST /api/v1/billing/fund-from-earnings"
        });
      }
    }
    const r = checkChatLimit({ bearer, ip, publicLimit: limit });
    if (!r.ok) {
      return err(429, "Rate limit exceeded — try again later", {
        resetAt: new Date(r.resetAt).toISOString()
      });
    }
  }

  // Plugins (remote MCP servers the person added): the server runs the tool
  // loop and streams events as SSE. `plugins: true` opts in; `resume` answers
  // an approval card. Plaintext only: the server must read the turn to run tools.
  if (payload?.plugins === true || payload?.resume) {
    let me = null;
    try { me = await requestUser(request); } catch { /* anonymous */ }
    const userId = me?.id ?? payer.userId ?? null;
    if (!userId) return err(401, "Sign in to use plugins");
    if (hasEncryptedPayload(payload)) return err(400, "Plugin turns are sent in plaintext (the server runs the tools); do not send encryptedMessages");
    return pluginChatResponse({ request, payload, userId, billing, payer, ip });
  }

  // IPIP-0026 §2.2 — accept either camelCase or snake_case from clients.
  const minTrustTierRaw = payload?.minTrustTier ?? payload?.min_trust_tier;
  const ALLOWED_TIERS = new Set(["public", "verified", "trusted"]);
  if (minTrustTierRaw !== undefined && !ALLOWED_TIERS.has(minTrustTierRaw)) {
    return err(400, "min_trust_tier must be one of: public, verified, trusted");
  }
  const minTrustTier = ALLOWED_TIERS.has(minTrustTierRaw) ? minTrustTierRaw : undefined;

  // Accept either plaintext messages[] or an encrypted NIP-44 payload.
  const hasPlain = Array.isArray(messages) && messages.length > 0;
  const hasEncrypted = typeof encryptedMessages === "string" && encryptedMessages.length > 0;
  if (!hasPlain && !hasEncrypted) {
    return err(400, "messages[] or encryptedMessages is required");
  }
  if (hasPlain && hasEncrypted) {
    return err(400, "Send plaintext messages or encryptedMessages, not both");
  }
  if (hasEncrypted && (!providerId || typeof clientPubkey !== "string" || !clientPubkey)) {
    return err(400, "E2E chat requires providerId and clientPubkey");
  }
  if (providerId && !hasEncrypted) {
    return err(400, "Provider-routed chat must use E2E encryption");
  }
  if (hasPlain) {
    for (const m of messages) {
      if (!m || typeof m.role !== "string" || typeof m.content !== "string") {
        return err(400, "Each message must be { role, content } strings");
      }
    }
  }

  try {
    const { job, provider, source, requestedModel } = await createChatJob({
      messages: hasPlain ? messages : undefined,
      encryptedMessages: hasEncrypted ? encryptedMessages : undefined,
      clientPubkey: typeof clientPubkey === "string" ? clientPubkey : undefined,
      modelPubkey: typeof modelPubkey === "string" ? modelPubkey : undefined,
      providerId: typeof providerId === "string" ? providerId : undefined,
      modelName,
      maxTokens,
      temperature,
      // IPIP-0033: when set, runRpcProxy in /api/chat/stream picks an
      // RPC primary + slice list and fans the request across them
      // instead of dispatching to a single provider. Persisted on the
      // job so the SSE handler picks the correct streaming path.
      distributed: distributed === true,
      minTrustTier,
      noFallback: wantsP2pOnly(payload),
      billedUserId: billing.mode === "balance" ? payer.userId : null
    });
    if (source === "none") {
      const available = await liveModelNames();
      return err(503, available.length === 0
        ? "No Infernet node is online right now. Try again later."
        : typeof modelName === "string" && modelName
          ? `No live node serves "${modelName}". Pick one of: ${available.join(", ")}.`
          : "No live node could take this request. Try again shortly.", {
        availableModels: available
      });
    }
    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      source,
      billing: billing.mode === "balance"
        ? { paid_from: "balance", spendable_usd: billing.spendable_usd }
        : { paid_from: "free", reason: billing.reason, free_remaining_today: freeLeft },
      model: job.model_name ?? null,
      ...(requestedModel ? { requestedModel } : {}),
      provider: provider
        ? {
            id: provider.id,
            name: provider.name,
            nodeId: provider.node_id,
            gpuModel: provider.gpu_model,
            model: provider.model ?? null,
            pubkey: provider.public_key ?? null
          }
        : null,
      streamUrl: `/api/chat/stream/${job.id}`
    }, {
      // p2p (an Infernet provider), c0mpute (a c0mpute worker serving
      // infernet.inference) or nim (the hosted fallback).
      headers: { "x-infernet-source": source }
    });
  } catch (e) {
    if (Number.isInteger(e?.status) && e.status >= 400 && e.status < 500) return err(e.status, e.message);
    return err(500, "Failed to create chat job", e?.message ?? String(e));
  }
}
