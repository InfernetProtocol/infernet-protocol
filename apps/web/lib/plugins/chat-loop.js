import "server-only";
import { runToolLoop } from "@profullstack/chat-plugins";
import { createChatJob, liveModelNames } from "@/lib/data/chat";
import { streamJobEvents } from "@/lib/data/chat-stream";
import { consumeFreeQuery } from "@/lib/data/free-tier";
import { loadLoopPlugins, netOptions, saveApproval, takeApproval } from "@/lib/plugins/store";

/*
 * /api/chat with plugins: the server runs the agent loop (model -> tool -> model)
 * with the person's enabled plugins and streams events back as SSE.
 *
 * Infernet nodes run Ollama models through their own /api/chat, which has no
 * tool calling, so the loop uses the prompt protocol from
 * @profullstack/chat-plugins: tools are described in a system prompt and the
 * model answers with one ```tool_call block. Each model call is an ordinary
 * chat job, billed like any other turn (billedUserId) or counted against the
 * free allowance.
 *
 * Plugin turns are not end-to-end encrypted: the server has to read the
 * conversation to run the tools. The page says so before sending.
 */

const UI_TEXT_LIMIT = 64 * 1024;
const MAX_HISTORY_CHARS = 200_000;
const ROLES = new Set(["system", "user", "assistant"]);

function withStatus(message, status) {
    return Object.assign(new Error(message), { status });
}

export function cleanHistory(messages) {
    if (!Array.isArray(messages) || !messages.length) throw withStatus("messages[] is required", 400);
    let total = 0;
    const out = [];
    for (const m of messages) {
        if (!m || !ROLES.has(m.role) || typeof m.content !== "string") {
            throw withStatus("Each message must be { role: system|user|assistant, content: string }", 400);
        }
        total += m.content.length;
        out.push({ role: m.role, content: m.content });
    }
    if (total > MAX_HISTORY_CHARS) throw withStatus("Conversation too long for a plugin turn; clear the chat and try again.", 413);
    return out;
}

function uiResult(ev) {
    const text = ev.text.length > UI_TEXT_LIMIT ? `${ev.text.slice(0, UI_TEXT_LIMIT)}\n\n[truncated for display]` : ev.text;
    return {
        type: "tool_result",
        id: ev.id,
        name: ev.name,
        plugin: ev.plugin,
        tool: ev.tool,
        isError: ev.isError,
        ...(ev.denied ? { denied: true } : {}),
        ...(ev.code ? { code: ev.code } : {}),
        text
    };
}

/**
 * Stream a plugin turn. `payer`/`billing` come from the /api/chat billing gate,
 * which has already counted the first model call.
 */
export function pluginChatResponse({ request, payload, userId, billing, payer, ip, net = netOptions() }) {
    const encoder = new TextEncoder();
    const modelName = typeof payload?.modelName === "string" && payload.modelName ? payload.modelName : undefined;
    const maxTokens = Number.isFinite(payload?.maxTokens) ? Math.min(Math.max(64, payload.maxTokens), 4096) : 2048;
    let closed = false;

    const stream = new ReadableStream({
        async start(controller) {
            const send = (obj) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
                } catch {
                    closed = true;
                }
            };
            const keepalive = setInterval(() => {
                if (closed) return;
                try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { closed = true; }
            }, 15_000);
            request.signal?.addEventListener?.("abort", () => { closed = true; });

            let modelCalls = 0;
            const complete = async (messages) => {
                if (closed) throw withStatus("cancelled", 499);
                modelCalls++;
                // The route already counted the first call; later steps of the loop
                // are more turns and are charged like them.
                if (modelCalls > 1 && billing.mode !== "balance") {
                    const free = await consumeFreeQuery({
                        userId: payer.userId ?? userId ?? null,
                        clientSubject: payer.subject ?? null,
                        ip,
                        fingerprint: request.headers.get("x-fingerprint"),
                        userAgent: request.headers.get("user-agent")
                    });
                    if (!free.ok) throw withStatus("Free daily limit reached during the plugin turn. Top up to keep going.", 429);
                }
                const { job, source, provider } = await createChatJob({
                    messages: messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })),
                    modelName,
                    maxTokens,
                    temperature: 0.4,
                    billedUserId: billing.mode === "balance" ? payer.userId : null
                });
                if (source === "none") {
                    const live = await liveModelNames();
                    throw withStatus(live.length ? `No live node serves "${modelName ?? "that model"}". Pick one of: ${live.join(", ")}.` : "No Infernet node is online right now.", 503);
                }
                send({ type: "step", step: modelCalls, model: job.model_name ?? modelName ?? null, provider: provider ? { name: provider.name ?? provider.node_id, model: provider.model ?? null } : null });
                let full = "";
                for await (const ev of streamJobEvents(job.id)) {
                    if (closed) break;
                    if (ev.type === "token") {
                        const t = ev.data?.text ?? "";
                        if (t) {
                            full += t;
                            send({ type: "token", text: t });
                        }
                    } else if (ev.type === "done") {
                        if (typeof ev.data?.text === "string" && ev.data.text.length > full.length) full = ev.data.text;
                        break;
                    } else if (ev.type === "error") {
                        throw withStatus(ev.data?.message ?? "The node failed to answer.", 502);
                    }
                }
                return full;
            };

            try {
                const { plugins, skipped } = await loadLoopPlugins(userId);
                if (skipped.length) send({ type: "plugins_skipped", skipped });
                let resume;
                let history;
                if (payload?.resume?.approvalId) {
                    const taken = await takeApproval(userId, payload.resume.approvalId);
                    resume = { pending: taken.pending, decision: payload.resume.decision === "allow" ? "allow" : "deny" };
                    history = taken.pending.messages;
                } else {
                    history = cleanHistory(payload?.messages);
                }
                send({ type: "plugins", plugins: plugins.map((p) => ({ slug: p.slug, name: p.name, tools: p.tools.length })) });
                const result = await runToolLoop({
                    messages: history,
                    plugins,
                    complete,
                    protocol: "prompt",
                    maxSteps: 6,
                    approve: () => "pending",
                    net,
                    // Small local models have small contexts: 8 KB of each result reaches the model.
                    modelTextLimit: 8 * 1024,
                    ...(resume ? { resume } : {}),
                    onEvent: (ev) => {
                        if (ev.type === "tool_call") send({ type: "tool_call", id: ev.id, name: ev.name, plugin: ev.plugin, tool: ev.tool, title: ev.title, arguments: ev.arguments });
                        else if (ev.type === "tool_result") send(uiResult(ev));
                        else if (ev.type === "text") send({ type: "text", text: ev.text });
                        // approval_needed is sent below, once it has an id.
                    }
                });
                if (result.status === "pending" && result.pending) {
                    const approvalId = await saveApproval(userId, result.pending, modelName);
                    const c = result.pending.call;
                    send({
                        type: "approval_needed",
                        approvalId,
                        call: { id: c.id, name: c.name, plugin: c.plugin, pluginName: c.pluginName, tool: c.tool, title: c.title, arguments: c.arguments }
                    });
                }
                send({ type: "done", status: result.status, steps: result.steps, ...(result.exhausted ? { exhausted: true } : {}) });
            } catch (e) {
                if (!(e?.status >= 400 && e.status < 500)) console.error("[chat/plugins]", e?.message ?? e);
                send({ type: "error", message: e?.message ?? String(e), status: e?.status ?? 500 });
            } finally {
                clearInterval(keepalive);
                closed = true;
                try { controller.close(); } catch { /* closed */ }
            }
        },
        cancel() {
            closed = true;
        }
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive"
        }
    });
}
