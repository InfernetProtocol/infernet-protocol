import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { hashKey, trustedKeyHashes, trustedClientFor, checkChatLimit, wantsP2pOnly } =
    await import("@/lib/trusted-clients");
const { rateLimit } = await import("@/lib/rate-limit");

const KEY = "ifc_0123456789abcdef0123456789abcdef0123456789abcdef";

describe("trusted client keys", () => {
    it("matches a presented key against the hashes in env, with its label", () => {
        const raw = `outreachgraph:${hashKey(KEY)}, junk, ${"a".repeat(64)}`;
        expect(trustedKeyHashes(raw).size).toBe(2);
        expect(trustedClientFor(KEY, raw)).toEqual({ name: "outreachgraph", hash: hashKey(KEY) });
        expect(trustedClientFor("ifc_wrong", raw)).toBeNull();
        expect(trustedClientFor("ifr_res_x", raw)).toBeNull();
        expect(trustedClientFor(null, raw)).toBeNull();
    });

    it("a trusted key skips the per-IP playground limit", () => {
        process.env.INFERNET_TRUSTED_CLIENT_KEYS = `og:${hashKey(KEY)}`;
        const publicLimit = rateLimit({ windowMs: 60_000, max: 1 });
        expect(checkChatLimit({ bearer: null, ip: "1.2.3.4", publicLimit }).ok).toBe(true);
        expect(checkChatLimit({ bearer: null, ip: "1.2.3.4", publicLimit }).ok).toBe(false);
        for (let i = 0; i < 25; i += 1) {
            const r = checkChatLimit({ bearer: KEY, ip: "1.2.3.4", publicLimit });
            expect(r.ok).toBe(true);
            expect(r.trusted?.name).toBe("og");
        }
        delete process.env.INFERNET_TRUSTED_CLIENT_KEYS;
    });

    it("p2p_only is read from either spelling", () => {
        expect(wantsP2pOnly({ p2p_only: true })).toBe(true);
        expect(wantsP2pOnly({ p2pOnly: "true" })).toBe(true);
        expect(wantsP2pOnly({ metadata: { p2p_only: true } })).toBe(true);
        expect(wantsP2pOnly({})).toBe(false);
    });
});
