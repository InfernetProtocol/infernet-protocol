/**
 * HTTP client for chat plugins (remote MCP servers on your account), shared by
 * `infernet plugins`, `infernet chat` and `infernet mcp`.
 *
 * Base URL: --url, INFERNET_URL, config.controlPlane.url, else infernetprotocol.com
 * Auth:     the `infernet login` bearer (config.auth.bearerToken) or --token
 */
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';

const DEFAULT_URL = 'https://infernetprotocol.com';

export async function resolvePluginsOptions(opts = {}) {
    const config = await loadConfig().catch(() => null);
    return {
        baseUrl: String(opts.url || process.env.INFERNET_URL || config?.controlPlane?.url || DEFAULT_URL).replace(/\/+$/, ''),
        token: opts.token || config?.auth?.bearerToken || null
    };
}

export function createPluginsClient({ baseUrl, token, fetchImpl = fetch }) {
    async function call(method, path, body) {
        if (!token) throw new Error('not signed in: run `infernet login` first');
        const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        if (!res.ok) {
            const err = new Error(json?.error ?? `${method} ${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        return json?.data ?? json;
    }
    const enc = encodeURIComponent;
    return {
        list: () => call('GET', '/api/v1/plugins'),
        add: (url) => call('POST', '/api/v1/plugins', { url }),
        remove: (slug) => call('DELETE', `/api/v1/plugins/${enc(slug)}`),
        toggle: (slug, enabled) => call('POST', `/api/v1/plugins/${enc(slug)}/toggle`, typeof enabled === 'boolean' ? { enabled } : {}),
        connectUrl: (slug) => `${baseUrl}/api/v1/plugins/${enc(slug)}/connect`
    };
}

/** Open a URL in the default browser; false when there is no way to (headless box). */
export function openBrowser(url) {
    if (process.env.INFERNET_NO_BROWSER === '1') return false;
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    try {
        const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
        return true;
    } catch {
        return false;
    }
}

/** Parse an SSE body into JSON events. */
export async function* readSse(res) {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try { yield JSON.parse(data); } catch { /* skip */ }
        }
    }
}
