/**
 * The OpenAI-compatible inference API (/v1/chat/completions, /v1/models) as
 * one small client, plus where the CLI keeps an API key.
 *
 * Shared by `infernet quickstart`, `infernet chat` (when a key is set) and
 * `infernet mcp` (chat_completion, models_list).
 *
 * Key resolution, first wins:
 *   --key <ik_live_...>        a flag
 *   INFERNET_API_KEY           the environment
 *   config.api.key             saved by `infernet quickstart`
 *
 * The key lives only in ~/.config/infernet/config.json (mode 0600), never in a
 * project file.
 */
import { loadConfig, saveConfig } from './config.js';

export const DEFAULT_API_URL = 'https://infernetprotocol.com';
export const API_KEY_PREFIX = 'ik_live_';

export function looksLikeApiKey(key) {
    return typeof key === 'string' && key.startsWith(API_KEY_PREFIX) && key.length > API_KEY_PREFIX.length + 8;
}

/** Show enough of a key to recognise it, never the whole thing. */
export function maskKey(key) {
    if (typeof key !== 'string' || key.length < 16) return '(hidden)';
    return `${key.slice(0, API_KEY_PREFIX.length + 4)}…${key.slice(-4)}`;
}

export function resolveApiKey({ flag, env = process.env, config } = {}) {
    if (flag) return { key: String(flag), source: '--key' };
    if (env?.INFERNET_API_KEY) return { key: env.INFERNET_API_KEY, source: 'INFERNET_API_KEY' };
    if (config?.api?.key) return { key: config.api.key, source: 'config' };
    return { key: null, source: null };
}

export function resolveBaseUrl({ flag, env = process.env, config } = {}) {
    return String(flag || env?.INFERNET_URL || config?.controlPlane?.url || DEFAULT_API_URL).replace(/\/+$/, '');
}

export async function resolveApiOptions({ url, key } = {}) {
    const config = (await loadConfig().catch(() => null)) ?? {};
    const k = resolveApiKey({ flag: key, config });
    return { baseUrl: resolveBaseUrl({ flag: url, config }), apiKey: k.key, keySource: k.source, config };
}

/** Save an API key under config.api; returns the config path. */
export async function saveApiKey({ key, id = null, name = null }) {
    const config = (await loadConfig().catch(() => null)) ?? {};
    return saveConfig({ ...config, api: { key, id, name, createdAt: new Date().toISOString() } });
}

/**
 * Turn an API error into one line a person can act on. Status codes are the
 * ones /v1/chat/completions actually returns.
 */
export function explainApiError(status, body) {
    const e = body?.error ?? {};
    const msg = typeof e === 'string' ? e : (e.message ?? `HTTP ${status}`);
    switch (status) {
        case 401:
            return `${msg}\n  fix: the key is missing, wrong or revoked. Run \`infernet quickstart\` for a new one.`;
        case 402:
            return `${msg}\n  fix: add funds with \`infernet billing topup 5\` (or move node earnings: \`infernet billing spend-earnings\`), `
                + 'or use a free model of 4B or under. The CLI never switches you to another paid provider.';
        case 429:
            if (e.free_limit_per_day) {
                return `${msg}\n  free requests used today: ${e.used_today}/${e.free_limit_per_day}. `
                    + 'Top up to keep going today: `infernet billing topup 5`.';
            }
            return `${msg}\n  fix: wait a moment and retry.`;
        case 503:
            return `${msg}${Array.isArray(e.available_models) && e.available_models.length ? `\n  live models: ${e.available_models.join(', ')}` : ''}`;
        default:
            return msg;
    }
}

export class InfernetApiError extends Error {
    constructor(status, body) {
        super(explainApiError(status, body));
        this.status = status;
        this.body = body;
    }
}

/** Parse an OpenAI-style SSE body into the text deltas it carries. */
export async function* readCompletionStream(body) {
    const decoder = new TextDecoder();
    let buf = '';
    const reader = body.getReader ? body.getReader() : null;
    const chunks = reader
        ? (async function* () { for (;;) { const { value, done } = await reader.read(); if (done) return; yield value; } })()
        : body;
    for await (const chunk of chunks) {
        buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            if (data === '[DONE]') return;
            let frame;
            try { frame = JSON.parse(data); } catch { continue; }
            if (frame?.error) throw new InfernetApiError(502, { error: frame.error });
            const delta = frame?.choices?.[0]?.delta?.content;
            if (delta) yield { text: delta, model: frame.model };
        }
    }
}

export function createApiClient({ baseUrl = DEFAULT_API_URL, apiKey = null, fetchImpl = fetch } = {}) {
    const root = String(baseUrl).replace(/\/+$/, '');
    const headers = (extra = {}) => ({
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...extra
    });

    async function fail(res) {
        const text = await res.text().catch(() => '');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = { error: { message: text.slice(0, 300) || `HTTP ${res.status}` } }; }
        throw new InfernetApiError(res.status, body);
    }

    return {
        baseUrl: root,

        async models() {
            const res = await fetchImpl(`${root}/v1/models`, { headers: headers() });
            if (!res.ok) await fail(res);
            const json = await res.json();
            return (json?.data ?? []).map((m) => m.id);
        },

        /**
         * One chat completion. With onToken, streams and calls onToken(text)
         * per delta; either way resolves { text, model, source }.
         */
        async chat({ messages, model = 'auto', maxTokens, temperature, onToken, signal } = {}) {
            if (!apiKey) throw new Error('no API key: run `infernet quickstart`, or set INFERNET_API_KEY');
            const stream = typeof onToken === 'function';
            const body = { model, messages, stream };
            if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
            if (Number.isFinite(temperature)) body.temperature = temperature;
            const res = await fetchImpl(`${root}/v1/chat/completions`, {
                method: 'POST',
                headers: headers({ 'content-type': 'application/json', ...(stream ? { accept: 'text/event-stream' } : {}) }),
                body: JSON.stringify(body),
                signal
            });
            if (!res.ok) await fail(res);
            const source = res.headers?.get?.('x-infernet-source') ?? null;
            if (!stream) {
                const json = await res.json();
                return { text: json?.choices?.[0]?.message?.content ?? '', model: json?.model ?? model, source };
            }
            let text = '';
            let served = model;
            for await (const d of readCompletionStream(res.body)) {
                text += d.text;
                if (d.model) served = d.model;
                onToken(d.text);
            }
            return { text, model: served, source };
        },

        /** Balance plus today's free allowance (GET /api/v1/billing/balance). */
        async balance() {
            if (!apiKey) throw new Error('no API key: run `infernet quickstart`, or set INFERNET_API_KEY');
            const res = await fetchImpl(`${root}/api/v1/billing/balance`, { headers: headers() });
            if (!res.ok) await fail(res);
            const json = await res.json();
            return json?.data ?? json;
        }
    };
}

/** Copy-paste snippets for the key the person just got (the env var, not the key). */
export function snippets(baseUrl = DEFAULT_API_URL) {
    const v1 = `${String(baseUrl).replace(/\/+$/, '')}/v1`;
    return {
        curl: `curl ${v1}/chat/completions \\
  -H "Authorization: Bearer $INFERNET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`,
        fetch: `const res = await fetch("${v1}/chat/completions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.INFERNET_API_KEY}\`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Hello" }] })
});
console.log((await res.json()).choices[0].message.content);`,
        openaiJs: `// npm i openai
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "${v1}", apiKey: process.env.INFERNET_API_KEY });
const r = await client.chat.completions.create({ model: "auto", messages: [{ role: "user", content: "Hello" }] });
console.log(r.choices[0].message.content);`,
        python: `# pip install openai
import os
from openai import OpenAI
client = OpenAI(base_url="${v1}", api_key=os.environ["INFERNET_API_KEY"])
r = client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hello"}])
print(r.choices[0].message.content)`
    };
}
