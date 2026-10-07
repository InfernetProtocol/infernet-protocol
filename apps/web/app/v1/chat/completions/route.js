import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { createChatJob, liveModelNames } from "@/lib/data/chat";
import { streamJobEvents } from "@/lib/data/chat-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OpenAI-compatible chat completions endpoint.
 *
 * Drop this URL into anything that speaks OpenAI:
 *   - Hermes (`ollama launch hermes` → custom endpoint)
 *   - LangChain (`OPENAI_API_BASE=…/v1`)
 *   - Cursor / Continue / Cline / Aider — same env var
 *   - openai-python / openai-node — same env var
 *
 * Wire format:
 *   POST /v1/chat/completions
 *   Body: { model, messages, stream?, temperature?, max_tokens?, ... }
 *
 *   stream=false → single JSON: { id, object: "chat.completion", choices: [...] }
 *   stream=true  → SSE: `data: <chunk>\n\n` chunks then `data: [DONE]\n\n`
 *
 * Internally: createChatJob() routes to a P2P provider (model-aware
 * weighted random pick), streamJobEvents() relays the daemon's
 * tokens; this route reformats them as OpenAI chunks.
 */
const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });

function err(status, message, extra) {
    // OpenAI-shaped error envelope so SDKs surface a useful message.
    return NextResponse.json(
        { error: { message, type: "infernet_error", code: status, ...extra } },
        { status }
    );
}

function makeId() {
    return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function chunkFrame({ id, model, deltaContent = null, finishReason = null, role = null }) {
    const delta = {};
    if (role) delta.role = role;
    if (deltaContent !== null) delta.content = deltaContent;
    return {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            { index: 0, delta, finish_reason: finishReason }
        ]
    };
}

export async function POST(request) {
    const ip = getClientIp(request);
    const r = limit.check(ip);
    if (!r.ok) return err(429, "Rate limit exceeded — try again later");

    let body;
    try {
        body = await request.json();
    } catch {
        return err(400, "invalid JSON body");
    }

    const { model, messages, stream, temperature, max_tokens } = body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) {
        return err(400, "messages[] is required");
    }
    for (const m of messages) {
        if (!m || typeof m.role !== "string" || typeof m.content !== "string") {
            return err(400, "each message must be { role: string, content: string }");
        }
    }

    // IPIP-0026 §2.2 — accept min_trust_tier per request (snake_case to
    // match the OpenAI request style; some clients pass it via extra
    // `metadata` so we look there too).
    const ALLOWED_TIERS = new Set(["public", "verified", "trusted"]);
    const minTrustTierRaw = body?.min_trust_tier ?? body?.metadata?.min_trust_tier;
    if (minTrustTierRaw !== undefined && !ALLOWED_TIERS.has(minTrustTierRaw)) {
        return err(400, "min_trust_tier must be one of: public, verified, trusted");
    }
    const minTrustTier = ALLOWED_TIERS.has(minTrustTierRaw) ? minTrustTierRaw : undefined;

    let jobBundle;
    try {
        jobBundle = await createChatJob({
            messages,
            modelName: typeof model === "string" ? model : undefined,
            maxTokens: Number.isFinite(max_tokens) ? max_tokens : undefined,
            temperature: Number.isFinite(temperature) ? temperature : undefined,
            minTrustTier
        });
    } catch (e) {
        return err(500, e?.message ?? "failed to create chat job");
    }

    if (jobBundle.source === "none") {
        const available = await liveModelNames();
        const message = available.length === 0
            ? "no Infernet node is online right now; try again later"
            : typeof model === "string" && model
                ? `no live node serves model "${model}"; pick one of: ${available.join(", ")}`
                : "no live node could take this request; try again shortly";
        return err(503, message, { available_models: available });
    }

    const job = jobBundle.job;
    const cmplId = makeId();
    const reportedModel = job.model_name ?? model ?? "infernet";

    // ---- Streaming path (OpenAI-shape SSE) -----------------------------
    if (stream === true) {
        const encoder = new TextEncoder();
        const sse = new ReadableStream({
            async start(controller) {
                let closed = false;
                const push = (text) => {
                    if (closed) return;
                    try { controller.enqueue(encoder.encode(text)); } catch { closed = true; }
                };
                const close = () => {
                    if (closed) return;
                    closed = true;
                    try { controller.close(); } catch { /* ignore */ }
                };

                // First chunk announces the assistant role per OpenAI's spec.
                push(`data: ${JSON.stringify(chunkFrame({ id: cmplId, model: reportedModel, role: "assistant", deltaContent: "" }))}\n\n`);

                try {
                    for await (const ev of streamJobEvents(job.id)) {
                        if (closed) break;
                        if (ev.type === "token") {
                            const text = ev.data?.text ?? "";
                            if (text) push(`data: ${JSON.stringify(chunkFrame({ id: cmplId, model: reportedModel, deltaContent: text }))}\n\n`);
                        } else if (ev.type === "done") {
                            push(`data: ${JSON.stringify(chunkFrame({ id: cmplId, model: reportedModel, finishReason: "stop" }))}\n\n`);
                            push(`data: [DONE]\n\n`);
                            close();
                            return;
                        } else if (ev.type === "error") {
                            const msg = ev.data?.message ?? "engine error";
                            // Emit error in OpenAI-ish shape and close — most clients
                            // don't expect a standalone error frame mid-stream, but
                            // it's the best signal we have without protocol extension.
                            push(`data: ${JSON.stringify({ id: cmplId, object: "chat.completion.chunk", error: { message: msg } })}\n\n`);
                            push(`data: [DONE]\n\n`);
                            close();
                            return;
                        }
                    }
                    // Generator ended without done/error — finalize anyway.
                    push(`data: ${JSON.stringify(chunkFrame({ id: cmplId, model: reportedModel, finishReason: "stop" }))}\n\n`);
                    push(`data: [DONE]\n\n`);
                    close();
                } catch (e) {
                    push(`data: ${JSON.stringify({ id: cmplId, object: "chat.completion.chunk", error: { message: e?.message ?? String(e) } })}\n\n`);
                    push(`data: [DONE]\n\n`);
                    close();
                }
            }
        });

        return new Response(sse, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive"
            }
        });
    }

    // ---- Non-streaming path (single JSON response) ---------------------
    let fullText = "";
    let finished = false;
    try {
        for await (const ev of streamJobEvents(job.id)) {
            if (ev.type === "token") fullText += ev.data?.text ?? "";
            else if (ev.type === "done") {
                if (typeof ev.data?.text === "string" && ev.data.text.length > fullText.length) {
                    fullText = ev.data.text;
                }
                finished = true;
                break;
            } else if (ev.type === "error") {
                return err(502, ev.data?.message ?? "engine error");
            }
        }
    } catch (e) {
        return err(500, e?.message ?? String(e));
    }

    if (!finished && !fullText) {
        return err(504, "stream ended without a response");
    }

    return NextResponse.json({
        id: cmplId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: reportedModel,
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: fullText },
                finish_reason: "stop"
            }
        ],
        // Token-level usage isn't tracked yet; callers that need it
        // should fall back to estimation (4 chars/token rough).
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
}
