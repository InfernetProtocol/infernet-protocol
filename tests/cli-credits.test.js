import { describe, it, expect } from "vitest";
import { createCreditsClient } from "../apps/cli/lib/credits-client.js";
import { TOOLS, handleMessage } from "../apps/cli/commands/mcp.js";

function fakeFetch(calls, body = { ok: true }) {
    return async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
}

describe("cli credits client", () => {
    it("uses the login bearer for user calls and the admin token for admin calls", async () => {
        const calls = [];
        const c = createCreditsClient({ baseUrl: "https://x.test", userToken: "user-jwt", adminToken: "admin-tok", fetchImpl: fakeFetch(calls) });
        await c.redeem("CR-AAAA-BBBB-CCCC-DDDD");
        await c.mintCode({ credits: 5 });
        expect(calls[0].url).toBe("https://x.test/api/v1/credits/redeem");
        expect(calls[0].init.headers.authorization).toBe("Bearer user-jwt");
        expect(JSON.parse(calls[0].init.body)).toEqual({ code: "CR-AAAA-BBBB-CCCC-DDDD" });
        expect(calls[1].url).toBe("https://x.test/api/v1/admin/credit-codes");
        expect(calls[1].init.headers.authorization).toBe("Bearer admin-tok");
    });

    it("refuses user calls without a login", async () => {
        const c = createCreditsClient({ baseUrl: "https://x.test", userToken: null, adminToken: null, fetchImpl: fakeFetch([]) });
        await expect(c.balance()).rejects.toThrow(/infernet login/);
    });

    it("exposes credit tools over MCP", async () => {
        expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["credits_balance", "credits_redeem", "invites_list", "invite_create"]));
        const client = { credits: { redeem: async (code) => ({ ok: true, code }) } };
        const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "credits_redeem", arguments: { code: "CR-1" } } }, client);
        expect(JSON.parse(res.result.content[0].text)).toEqual({ ok: true, code: "CR-1" });
    });
});
