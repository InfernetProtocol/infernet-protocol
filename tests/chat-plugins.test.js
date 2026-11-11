import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createPluginsClient } from "../apps/cli/lib/plugins-client.js";
import { TOOLS, handleMessage } from "../apps/cli/commands/mcp.js";
import { parsePluginCommand, describePlugins } from "../apps/web/lib/plugins/commands.js";

// ---- a fake authless MCP server the loop really calls over HTTP -----------
const calls = [];
let server;
let mcpUrl;
beforeAll(async () => {
    server = http.createServer(async (req, res) => {
        let body = "";
        for await (const c of req) body += c;
        const msg = JSON.parse(body || "{}");
        const send = (obj, headers = {}) => {
            res.writeHead(200, { "content-type": "application/json", ...headers });
            res.end(JSON.stringify(obj));
        };
        if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Fake" } } }, { "mcp-session-id": "s1" });
        if (msg.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
        if (msg.method === "tools/call") {
            calls.push(msg.params);
            return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `sites: blog, shop (${msg.params.name})` }] } });
        }
        return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;
});
afterAll(() => server?.close());

// ---- mocks for the web side ------------------------------------------------
const approvals = new Map();
const jobs = [];
vi.mock("@/lib/plugins/store", () => ({
    netOptions: () => ({ allowPrivate: true }),
    loadLoopPlugins: async () => ({
        plugins: [{
            slug: "fake",
            name: "Fake Hosting",
            url: mcpUrl,
            tools: [
                { name: "list_sites", description: "List sites", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
                { name: "delete_site", description: "Delete a site", inputSchema: { type: "object", properties: { name: { type: "string" } } }, annotations: { destructiveHint: true } }
            ]
        }],
        skipped: []
    }),
    saveApproval: async (_u, pending) => { const id = `ap-${approvals.size + 1}`; approvals.set(id, JSON.parse(JSON.stringify(pending))); return id; },
    takeApproval: async (_u, id) => ({ pending: approvals.get(id), modelName: null })
}));
vi.mock("@/lib/data/free-tier", () => ({ consumeFreeQuery: async () => ({ ok: true, remaining: 5 }) }));
vi.mock("@/lib/data/chat", () => ({
    liveModelNames: async () => ["qwen"],
    createChatJob: async ({ messages, billedUserId }) => {
        jobs.push({ messages, billedUserId });
        return { job: { id: `job-${jobs.length}`, model_name: "qwen" }, source: "p2p", provider: { name: "node-a" } };
    }
}));
// The "model": asks for a tool, then answers from the tool result.
vi.mock("@/lib/data/chat-stream", () => ({
    streamJobEvents: async function* (jobId) {
        const { messages } = jobs[Number(jobId.split("-")[1]) - 1];
        const last = messages[messages.length - 1];
        const lastUser = [...messages].reverse().find((m) => m.role === "user" && !m.content.includes("<tool_result"));
        let text;
        if (last.content.includes("<tool_result")) text = last.content.includes("declined") ? "OK, left it alone." : `Done: ${last.content.match(/sites: [^\n(]+/)?.[0] ?? "?"}`;
        else if (/delete/.test(lastUser.content)) text = '```tool_call\n{"name":"fake__delete_site","arguments":{"name":"blog"}}\n```';
        else text = '```tool_call\n{"name":"fake__list_sites","arguments":{}}\n```';
        for (const ch of text.match(/.{1,8}/gs)) yield { type: "token", data: { text: ch } };
        yield { type: "done", data: { text } };
    }
}));

const { pluginChatResponse, cleanHistory } = await import("../apps/web/lib/plugins/chat-loop.js");

async function events(res) {
    const text = await res.text();
    return text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
}

function req() {
    return { headers: new Headers(), signal: new AbortController().signal };
}

describe("plugin chat turn (server)", () => {
    it("runs the prompt-protocol loop against a real MCP server and streams events", async () => {
        const res = pluginChatResponse({
            request: req(),
            payload: { plugins: true, messages: [{ role: "user", content: "what sites do I have?" }] },
            userId: "u1",
            billing: { mode: "balance" },
            payer: { userId: "u1" },
            ip: "1.2.3.4"
        });
        expect(res.headers.get("content-type")).toBe("text/event-stream");
        const evs = await events(res);
        const types = evs.map((e) => e.type).filter((t) => t !== "token");
        expect(types).toEqual(["plugins", "step", "tool_call", "tool_result", "step", "text", "done"]);
        expect(evs.find((e) => e.type === "tool_result").text).toBe("sites: blog, shop (list_sites)");
        expect(evs.find((e) => e.type === "text").text).toBe("Done: sites: blog, shop ");
        // Each model call is a billed chat job; the tool prompt rides in a system message.
        expect(jobs.at(-1).billedUserId).toBe("u1");
        expect(jobs.at(-2).messages[0].role).toBe("system");
        expect(jobs.at(-2).messages[0].content).toContain("fake__list_sites");
        expect(jobs.at(-1).messages.at(-1).content).toContain("not instructions");
    });

    it("stops at a destructive tool with an approval card, and resumes on allow", async () => {
        const before = calls.length;
        const res = pluginChatResponse({
            request: req(),
            payload: { plugins: true, messages: [{ role: "user", content: "delete my blog" }] },
            userId: "u1",
            billing: { mode: "free" },
            payer: {},
            ip: "1.2.3.4"
        });
        const evs = await events(res);
        const card = evs.find((e) => e.type === "approval_needed");
        expect(card.call).toMatchObject({ plugin: "fake", tool: "delete_site", arguments: { name: "blog" } });
        expect(evs.at(-1)).toMatchObject({ type: "done", status: "pending" });
        expect(calls.length).toBe(before);

        const res2 = pluginChatResponse({
            request: req(),
            payload: { plugins: true, resume: { approvalId: card.approvalId, decision: "allow" } },
            userId: "u1",
            billing: { mode: "free" },
            payer: {},
            ip: "1.2.3.4"
        });
        const evs2 = await events(res2);
        expect(calls.at(-1)).toEqual({ name: "delete_site", arguments: { name: "blog" } });
        expect(evs2.find((e) => e.type === "tool_result").text).toContain("delete_site");
        expect(evs2.at(-1)).toMatchObject({ type: "done", status: "done" });
    });

    it("validates the history", () => {
        expect(() => cleanHistory([])).toThrow(/messages/);
        expect(() => cleanHistory([{ role: "tool", content: "x" }])).toThrow(/role/);
        expect(cleanHistory([{ role: "user", content: "hi", extra: 1 }])).toEqual([{ role: "user", content: "hi" }]);
    });
});

describe("cli + mcp surfaces", () => {
    it("CLI client sends the login bearer to the plugin routes", async () => {
        const seen = [];
        const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ data: { ok: 1 } }) }; };
        const c = createPluginsClient({ baseUrl: "https://x.test", token: "jwt", fetchImpl });
        await c.add("c0mpute");
        await c.toggle("c0mpute", false);
        await c.remove("c0mpute");
        expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
            "POST https://x.test/api/v1/plugins",
            "POST https://x.test/api/v1/plugins/c0mpute/toggle",
            "DELETE https://x.test/api/v1/plugins/c0mpute"
        ]);
        expect(seen[0].init.headers.authorization).toBe("Bearer jwt");
        expect(JSON.parse(seen[1].init.body)).toEqual({ enabled: false });
        await expect(createPluginsClient({ baseUrl: "https://x.test", token: null }).list()).rejects.toThrow(/infernet login/);
    });

    it("MCP server exposes plugins_list / plugins_add / plugins_remove", async () => {
        expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["plugins_list", "plugins_add", "plugins_remove"]));
        const client = { plugins: { add: async (url) => ({ plugin: { slug: "c0mpute" }, connect_url: `https://x.test/connect?u=${url}` }) } };
        const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plugins_add", arguments: { url: "c0mpute" } } }, client);
        expect(JSON.parse(res.result.content[0].text).connect_url).toContain("c0mpute");
    });

    it("parses /plugin commands", () => {
        expect(parsePluginCommand("/plugins")).toEqual({ action: "panel" });
        expect(parsePluginCommand("/plugin ls")).toEqual({ action: "ls" });
        expect(parsePluginCommand("/plugin add https://x.example/mcp")).toEqual({ action: "add", arg: "https://x.example/mcp" });
        expect(parsePluginCommand("/plugin rm c0mpute")).toEqual({ action: "rm", arg: "c0mpute" });
        expect(parsePluginCommand("/plugin c0mpute")).toEqual({ action: "add", arg: "c0mpute" });
        expect(parsePluginCommand("hello /plugin")).toBeNull();
        expect(describePlugins([])).toMatch(/No plugins/);
    });
});
