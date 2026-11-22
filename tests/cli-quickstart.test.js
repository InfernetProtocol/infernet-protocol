import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runQuickstart, runStatus } from "../apps/cli/commands/quickstart.js";
import {
    createApiClient, resolveApiKey, maskKey, explainApiError, snippets, readCompletionStream
} from "../apps/cli/lib/api-client.js";
import { resolveBatchOptions } from "../apps/cli/lib/batch-client.js";
import { TOOLS, handleMessage } from "../apps/cli/commands/mcp.js";

const KEY = "ik_live_0123456789abcdef0123456789abcdef";

function sseBody(frames) {
    const text = frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
    return new Response(text, { headers: { "content-type": "text/event-stream", "x-infernet-source": "p2p" } }).body;
}

function chunk(content, model = "qwen2.5:7b") {
    return { object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

/** A fake prod: records calls, answers keys / completions / models / balance. */
function fakeApi({ completionStatus = 200, completionError = null } = {}) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, init });
        const json = (body, status = 200) => ({
            ok: status < 400, status, headers: new Headers(),
            json: async () => body, text: async () => JSON.stringify(body)
        });
        if (u.endsWith("/api/v1/keys") && init.method === "POST") {
            return json({ data: { id: "key-1", key: KEY, prefix: KEY.slice(0, 12) } }, 201);
        }
        if (u.endsWith("/v1/chat/completions")) {
            if (completionStatus !== 200) return json({ error: completionError ?? { message: "nope" } }, completionStatus);
            return {
                ok: true, status: 200,
                headers: new Headers({ "x-infernet-source": "p2p" }),
                body: sseBody([chunk("Hello"), chunk(" world"), "[DONE]"])
            };
        }
        if (u.endsWith("/v1/models")) return json({ object: "list", data: [{ id: "qwen2.5:7b" }, { id: "gemma3:4b" }] });
        if (u.endsWith("/api/v1/billing/balance")) {
            return json({ data: { total_spendable_usd: "1.500000", free_today: { limit: 10, used: 3, remaining: 7 } } });
        }
        return json({ error: "unexpected" }, 404);
    };
    return { calls, fetchImpl };
}

function sink() {
    let text = "";
    return { write: (s) => { text += s; }, get text() { return text; } };
}

let dir;
let savedEnv;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "infernet-qs-"));
    savedEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, INFERNET_API_KEY: process.env.INFERNET_API_KEY, INFERNET_URL: process.env.INFERNET_URL };
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.INFERNET_API_KEY;
    delete process.env.INFERNET_URL;
});
afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

const configPath = () => path.join(dir, "infernet", "config.json");
const readConfig = () => JSON.parse(fs.readFileSync(configPath(), "utf8"));
const writeConfig = (c) => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(c));
};

describe("infernet quickstart", () => {
    it("signs in, creates and stores a key, runs a test call and prints snippets", async () => {
        const { calls, fetchImpl } = fakeApi();
        let loggedIn = 0;
        const login = async () => {
            loggedIn += 1;
            writeConfig({ auth: { bearerToken: "cli-jwt", userId: "u1" } });
            return 0;
        };
        const out = sink();
        const err = sink();
        const { code, result } = await runQuickstart({}, { fetchImpl, login, out, err, isTTY: true });

        expect(code).toBe(0);
        expect(loggedIn).toBe(1);
        const keyCall = calls.find((c) => c.url.endsWith("/api/v1/keys"));
        expect(keyCall.init.headers.authorization).toBe("Bearer cli-jwt");
        expect(JSON.parse(keyCall.init.body)).toEqual({ name: "quickstart" });

        const cfg = readConfig();
        expect(cfg.api.key).toBe(KEY);
        expect(cfg.api.id).toBe("key-1");
        expect(cfg.auth.bearerToken).toBe("cli-jwt");
        expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);

        const chat = calls.find((c) => c.url.endsWith("/v1/chat/completions"));
        expect(chat.init.headers.authorization).toBe(`Bearer ${KEY}`);
        const body = JSON.parse(chat.init.body);
        expect(body.model).toBe("auto");
        expect(body.stream).toBe(true);

        expect(result.test).toMatchObject({ ok: true, text: "Hello world", model: "qwen2.5:7b" });
        expect(out.text).toContain("Hello world");
        expect(out.text).toContain(`export INFERNET_API_KEY=${KEY}`);
        expect(out.text).toContain("https://infernetprotocol.com/v1/chat/completions");
        expect(out.text).toContain('base_url="https://infernetprotocol.com/v1"');
        expect(out.text).toContain("claude plugin install infernet@infernet");
    });

    it("is idempotent: a stored key skips sign-in and key creation", async () => {
        writeConfig({ api: { key: KEY } });
        const { calls, fetchImpl } = fakeApi();
        const login = async () => { throw new Error("must not sign in"); };
        const out = sink();
        const { code, result } = await runQuickstart({}, { fetchImpl, login, out, err: sink(), isTTY: true });
        expect(code).toBe(0);
        expect(calls.some((c) => c.url.endsWith("/api/v1/keys"))).toBe(false);
        expect(result.key_created).toBe(false);
        // An existing key is never echoed in full.
        expect(out.text).not.toContain(KEY);
        expect(out.text).toContain(maskKey(KEY));
        expect(out.text).toContain('export INFERNET_API_KEY="$(infernet quickstart key)"');
    });

    it("uses INFERNET_API_KEY without writing it to the config", async () => {
        process.env.INFERNET_API_KEY = KEY;
        const { fetchImpl } = fakeApi();
        const { code, result } = await runQuickstart({ noTest: true }, { fetchImpl, login: async () => 1, out: sink(), err: sink() });
        expect(code).toBe(0);
        expect(result.key_source).toBe("INFERNET_API_KEY");
        expect(fs.existsSync(configPath())).toBe(false);
    });

    it("stores a pasted --key and refuses something that is not a key", async () => {
        const { fetchImpl } = fakeApi();
        const bad = await runQuickstart({ key: "sk-not-ours", noTest: true }, { fetchImpl, out: sink(), err: sink() });
        expect(bad.code).toBe(2);
        const good = await runQuickstart({ key: KEY, noTest: true }, { fetchImpl, out: sink(), err: sink() });
        expect(good.code).toBe(0);
        expect(readConfig().api.key).toBe(KEY);
    });

    it("emits one JSON document with --json and never the full key", async () => {
        writeConfig({ api: { key: KEY } });
        const { fetchImpl } = fakeApi();
        const out = sink();
        const { code } = await runQuickstart({ json: true }, { fetchImpl, out, err: sink() });
        expect(code).toBe(0);
        const doc = JSON.parse(out.text);
        expect(doc.test.ok).toBe(true);
        expect(doc.api_base).toBe("https://infernetprotocol.com/v1");
        expect(doc.snippets.python).toContain("OpenAI(base_url=");
        expect(out.text).not.toContain(KEY);
    });

    it("explains a 402 and exits non-zero, keeping the key", async () => {
        writeConfig({ api: { key: KEY } });
        const { fetchImpl } = fakeApi({ completionStatus: 402, completionError: { message: "out of compute balance", reason: "insufficient" } });
        const err = sink();
        const { code, result } = await runQuickstart({}, { fetchImpl, out: sink(), err });
        expect(code).toBe(1);
        expect(result.test.status).toBe(402);
        expect(err.text).toMatch(/billing topup/);
        expect(err.text).toMatch(/never falls back to a paid provider/);
        expect(readConfig().api.key).toBe(KEY);
    });

    it("signs in again when the saved sign-in is refused, then creates the key", async () => {
        writeConfig({ auth: { bearerToken: "stale-jwt", userId: "u1" } });
        const { calls, fetchImpl: base } = fakeApi();
        const fetchImpl = async (url, init = {}) => {
            if (String(url).endsWith("/api/v1/keys") && init.headers?.authorization === "Bearer stale-jwt") {
                calls.push({ url: String(url), init });
                return { ok: false, status: 401, headers: new Headers(), text: async () => JSON.stringify({ error: "sign in first" }) };
            }
            return base(url, init);
        };
        let logins = 0;
        const login = async () => { logins += 1; writeConfig({ auth: { bearerToken: "fresh-jwt", userId: "u1" } }); return 0; };
        const { code } = await runQuickstart({ noTest: true }, { fetchImpl, login, out: sink(), err: sink() });
        expect(code).toBe(0);
        expect(logins).toBe(1);
        const keyCalls = calls.filter((c) => c.url.endsWith("/api/v1/keys"));
        expect(keyCalls.map((c) => c.init.headers.authorization)).toEqual(["Bearer stale-jwt", "Bearer fresh-jwt"]);
        expect(readConfig().api.key).toBe(KEY);
    });

    it("stops cleanly when sign-in does not finish", async () => {
        const { fetchImpl } = fakeApi();
        const err = sink();
        const { code } = await runQuickstart({}, { fetchImpl, login: async () => 1, out: sink(), err });
        expect(code).toBe(1);
        expect(err.text).toMatch(/--key ik_live_/);
    });
});

describe("infernet quickstart status", () => {
    it("reports key, balance, free requests left and live models", async () => {
        writeConfig({ api: { key: KEY } });
        const { fetchImpl } = fakeApi();
        const out = sink();
        const { code, status } = await runStatus({ json: true }, { fetchImpl, out });
        expect(code).toBe(0);
        expect(status.key_configured).toBe(true);
        expect(status.free_today).toEqual({ limit: 10, used: 3, remaining: 7 });
        expect(status.balance.total_spendable_usd).toBe("1.500000");
        expect(status.live_models).toEqual(["qwen2.5:7b", "gemma3:4b"]);
    });

    it("exits 1 with no key but still lists live models", async () => {
        const { fetchImpl } = fakeApi();
        const out = sink();
        const { code, status } = await runStatus({}, { fetchImpl, out });
        expect(code).toBe(1);
        expect(status.live_models.length).toBe(2);
        expect(out.text).toMatch(/infernet quickstart/);
    });
});

describe("api client", () => {
    it("resolves the key flag > env > config", () => {
        expect(resolveApiKey({ flag: "a", env: { INFERNET_API_KEY: "b" }, config: { api: { key: "c" } } }).key).toBe("a");
        expect(resolveApiKey({ env: { INFERNET_API_KEY: "b" }, config: { api: { key: "c" } } }).key).toBe("b");
        expect(resolveApiKey({ env: {}, config: { api: { key: "c" } } })).toEqual({ key: "c", source: "config" });
        expect(resolveApiKey({ env: {}, config: {} }).key).toBe(null);
    });

    it("parses a streamed completion and surfaces a mid-stream error", async () => {
        const parts = [];
        for await (const d of readCompletionStream(sseBody([chunk("a"), chunk("b"), "[DONE]"]))) parts.push(d.text);
        expect(parts).toEqual(["a", "b"]);
        const broken = sseBody([chunk("a"), { error: { message: "engine error" } }]);
        await expect((async () => { for await (const _ of readCompletionStream(broken)) { /* drain */ } })()).rejects.toThrow(/engine error/);
    });

    it("turns 429 free-limit errors into the allowance", () => {
        const msg = explainApiError(429, { error: { message: "Free limit reached", free_limit_per_day: 10, used_today: 10 } });
        expect(msg).toMatch(/10\/10/);
    });

    it("non-streaming chat returns the message", async () => {
        const fetchImpl = async () => ({
            ok: true, status: 200, headers: new Headers(),
            json: async () => ({ model: "gemma3:4b", choices: [{ message: { content: "OK" } }] })
        });
        const r = await createApiClient({ apiKey: KEY, fetchImpl }).chat({ messages: [{ role: "user", content: "x" }] });
        expect(r).toMatchObject({ text: "OK", model: "gemma3:4b" });
    });

    it("snippets use the env var, never a key", () => {
        const s = snippets();
        for (const v of Object.values(s)) expect(v).toMatch(/INFERNET_API_KEY/);
        expect(s.openaiJs).toContain('baseURL: "https://infernetprotocol.com/v1"');
    });

    it("billing/batch commands pick up the stored key", async () => {
        writeConfig({ api: { key: KEY } });
        expect((await resolveBatchOptions({})).apiKey).toBe(KEY);
    });
});

describe("mcp chat tools", () => {
    it("lists chat_completion and models_list and runs them through the API client", async () => {
        expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["chat_completion", "models_list"]));
        const seen = [];
        const client = { api: { chat: async (a) => { seen.push(a); return { text: "OK", model: "m" }; }, models: async () => ["m"] } };
        const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chat_completion", arguments: { prompt: "hi", system: "be brief" } } }, client);
        expect(JSON.parse(res.result.content[0].text)).toEqual({ text: "OK", model: "m" });
        expect(seen[0].model).toBe("auto");
        expect(seen[0].messages).toEqual([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
        const models = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "models_list", arguments: {} } }, client);
        expect(JSON.parse(models.result.content[0].text)).toEqual(["m"]);
    });
});
