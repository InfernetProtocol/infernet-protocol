import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => ({}) }));

const { formatGeo, isPublicIp } = await import("@/lib/geo");
const { buildSilentNodeEmail, emailSilentNodes } = await import("@/lib/silent-nodes");

describe("geo", () => {
    it("only looks up public addresses", () => {
        expect(isPublicIp("23.95.86.145")).toBe(true);
        expect(isPublicIp("10.1.2.3")).toBe(false);
        expect(isPublicIp("192.168.1.9")).toBe(false);
        expect(isPublicIp("172.20.0.1")).toBe(false);
        expect(isPublicIp("100.72.0.1")).toBe(false);
        expect(isPublicIp("127.0.0.1")).toBe(false);
        expect(isPublicIp("anonymous")).toBe(false);
        expect(isPublicIp("2a01:4f8::1")).toBe(true);
        expect(isPublicIp("fd00::1")).toBe(false);
    });

    it("formats place and network, deduping repeated names", () => {
        expect(formatGeo({ city: "Vienna", region: "Vienna", country: "Austria", network: "netcup GmbH" }))
            .toBe("Vienna, Austria · netcup GmbH");
        expect(formatGeo(null)).toBeNull();
    });
});

describe("silent-node email", () => {
    it("names the node and gives the restart commands", () => {
        const m = buildSilentNodeEmail({ role: "provider", node: { id: "u1", name: "cullen3", last_seen: "2026-10-19T08:00:00Z" } });
        expect(m.subject).toBe('Your Infernet provider "cullen3" went offline');
        expect(m.text).toContain("infernet setup --yes");
        expect(m.text).toContain("https://infernetprotocol.com/nodes/u1");
        expect(m.html).not.toContain("<script");
    });

    it("claims the node before sending, so it mails once", async () => {
        const updates = [];
        const node = { id: "p1", name: "n", public_key: "k".repeat(64), last_seen: "2026-10-19T00:00:00Z" };
        const chain = (result) => {
            const q = {};
            for (const m of ["select", "is", "lt", "gte", "eq", "in"]) q[m] = () => q;
            q.limit = () => q;
            q.maybeSingle = () => Promise.resolve(result);
            q.then = (res, rej) => Promise.resolve(result).then(res, rej);
            return q;
        };
        const supabase = {
            from(table) {
                if (table === "pubkey_links") return chain({ data: { user_id: "user-1" } });
                return {
                    select: () => chain({ data: table === "providers" ? [node] : [] }),
                    update: (patch) => { updates.push([table, patch]); return chain({ data: [{ id: node.id }] }); }
                };
            },
            auth: { admin: { getUserById: async () => ({ data: { user: { email: "op@example.com" } } }) } }
        };
        const sent = [];
        const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
        const out = await emailSilentNodes(supabase, { now: new Date("2026-10-21T00:00:00Z"), apiKey: "re_x", fetchImpl });
        expect(out).toEqual({ emailed: 1, skipped: 0, errors: 0 });
        expect(updates[0][0]).toBe("providers");
        expect(updates[0][1].silence_emailed_at).toBeTruthy();
        expect(sent[0].to).toEqual(["op@example.com"]);
    });

    it("does nothing without a Resend key", async () => {
        expect(await emailSilentNodes({}, { apiKey: "" })).toEqual({ emailed: 0, skipped: 0, errors: 0 });
    });
});
