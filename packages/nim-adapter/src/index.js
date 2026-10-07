/**
 * NVIDIA NIM / build.nvidia.com adapter.
 *
 * Treats NVIDIA's OpenAI-compatible inference endpoint as a fallback
 * "virtual provider" for Infernet. Used when the P2P network has no
 * live providers available — chat still feels instant to users during
 * the bootstrap phase.
 *
 * Env vars:
 *   NVIDIA_NIM_API_KEY        required to enable the adapter
 *   NVIDIA_NIM_API_URL        default https://integrate.api.nvidia.com/v1
 *   NVIDIA_NIM_DEFAULT_MODEL  default meta/llama-3.3-70b-instruct
 *   HOSTED_FALLBACK_NAME      what users see as the provider, default
 *                             "NVIDIA NIM (fallback)"
 *
 * Any OpenAI-compatible endpoint works with the same three variables, e.g.
 * Cloudflare Workers AI:
 *   NVIDIA_NIM_API_URL=https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1
 *   NVIDIA_NIM_DEFAULT_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
 *   HOSTED_FALLBACK_NAME="Cloudflare Workers AI (fallback)"
 *
 * OpenAI-compatible schema: we can reuse this adapter for any future
 * OpenAI-shaped endpoint by just swapping the base URL + key.
 */

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = "meta/llama-3.3-70b-instruct";

export function isNimConfigured() {
    return typeof process.env.NVIDIA_NIM_API_KEY === "string" && process.env.NVIDIA_NIM_API_KEY.length > 0;
}

export function fallbackName() {
    return process.env.HOSTED_FALLBACK_NAME || "NVIDIA NIM (fallback)";
}

export function nimDefaults() {
    return {
        baseUrl: (process.env.NVIDIA_NIM_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
        model:   process.env.NVIDIA_NIM_DEFAULT_MODEL ?? DEFAULT_MODEL
    };
}

/**
 * Stream a chat completion from NVIDIA NIM. Async generator yielding
 * normalized events matching the shape the rest of Infernet emits:
 *
 *   { type: 'meta',  data: { provider: 'nvidia-nim', model, started_at } }
 *   { type: 'token', data: { text } }
 *   { type: 'done',  data: { text, finished_at } }
 *   { type: 'error', data: { message } }
 *
 * @param {{
 *   messages: Array<{ role: string, content: string }>,
 *   model?: string,
 *   maxTokens?: number,
 *   temperature?: number,
 *   signal?: AbortSignal
 * }} opts
 */
export async function* streamChatCompletion(opts = {}) {
    const { messages, maxTokens = 512, temperature = 0.7, signal } = opts;
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("nim: messages[] is required");
    }
    const apiKey = process.env.NVIDIA_NIM_API_KEY;
    if (!apiKey) {
        throw new Error("nim: NVIDIA_NIM_API_KEY is not set");
    }

    const { baseUrl, model: defaultModel } = nimDefaults();
    const model = opts.model ?? defaultModel;

    yield { type: "meta", data: {
        provider: "nvidia-nim",
        model,
        started_at: new Date().toISOString()
    }};

    let res;
    try {
        res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream"
            },
            body: JSON.stringify({
                model,
                messages,
                max_tokens: maxTokens,
                temperature,
                stream: true
            }),
            signal
        });
    } catch (err) {
        yield { type: "error", data: { message: `nim fetch failed: ${err?.message ?? err}` } };
        return;
    }

    if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        yield {
            type: "error",
            data: { message: `nim HTTP ${res.status}: ${body.slice(0, 500)}` }
        };
        return;
    }

    let fullText = "";
    try {
        for await (const frame of parseOpenAiSseFrames(res.body)) {
            if (frame === "[DONE]") break;
            // Workers AI sends a token that is a bare number as a JSON number
            // ({"content":1}), so a string-only check dropped every digit.
            const raw = frame?.choices?.[0]?.delta?.content;
            const delta = typeof raw === "number" ? String(raw) : raw;
            if (typeof delta === "string" && delta.length > 0) {
                fullText += delta;
                yield { type: "token", data: { text: delta } };
            }
            const finish = frame?.choices?.[0]?.finish_reason;
            if (finish) {
                // finish reason appears before [DONE]; the loop breaks next iteration.
            }
        }
    } catch (err) {
        yield { type: "error", data: { message: `nim stream error: ${err?.message ?? err}` } };
        return;
    }

    yield { type: "done", data: { text: fullText, finished_at: new Date().toISOString() } };
}

/**
 * Describe NIM as a "virtual provider" for the chat UI badge.
 */
export function nimVirtualProvider() {
    const { model } = nimDefaults();
    return {
        id: null,
        node_id: "nvidia-nim",
        name: fallbackName(),
        gpu_model: "hosted",
        model
    };
}

// ---------------------------------------------------------------------------
// Minimal SSE parser for OpenAI-shaped streams. Frames are separated by
// blank lines; `data:` lines carry JSON, except for the terminator "[DONE]".
// ---------------------------------------------------------------------------
async function* parseOpenAiSseFrames(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        for (;;) {
            const splitAt = buf.indexOf("\n\n");
            if (splitAt < 0) break;
            const raw = buf.slice(0, splitAt);
            buf = buf.slice(splitAt + 2);
            const frame = parseFrame(raw);
            if (frame != null) yield frame;
        }
    }
    const tail = parseFrame(buf);
    if (tail != null) yield tail;
}

function parseFrame(raw) {
    if (!raw || raw.startsWith(":")) return null;
    const dataLines = [];
    for (const line of raw.split("\n")) {
        if (!line) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) return null;
    const text = dataLines.join("\n").trim();
    if (text === "[DONE]") return "[DONE]";
    try { return JSON.parse(text); }
    catch { return null; }
}
