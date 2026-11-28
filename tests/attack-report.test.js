import { afterEach, describe, expect, it, vi } from "vitest";

const updateUserById = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/server", () => ({
    getSupabaseServerClient: () => ({ auth: { admin: { updateUserById } } })
}));

const { trustedClientIp, threatcrushDetectionLine, reportAttack } = await import("@/lib/security/attack-report");

const req = (headers) => new Request("https://infernetprotocol.com/api/v1/training/jobs", { method: "POST", headers });

afterEach(() => {
    vi.restoreAllMocks();
    updateUserById.mockClear();
});

describe("trustedClientIp", () => {
    it("uses the last X-Forwarded-For hop, which nginx appended, not the client's first", () => {
        expect(trustedClientIp(req({ "x-forwarded-for": "1.1.1.1, 198.51.100.7" }))).toBe("198.51.100.7");
    });
    it("falls back to X-Real-IP, and ignores junk", () => {
        expect(trustedClientIp(req({ "x-real-ip": "2001:db8::5" }))).toBe("2001:db8::5");
        expect(trustedClientIp(req({ "x-forwarded-for": "not-an-ip" }))).toBe(null);
        expect(trustedClientIp(req({}))).toBe(null);
    });
});

describe("threatcrushDetectionLine", () => {
    it("matches the ThreatCrush docker-logs v1 contract", () => {
        const line = threatcrushDetectionLine({ ip: "198.51.100.7", category: "app.rce_payload", reason: "code in\ntraining", account: "u1" });
        expect(line.startsWith("THREATCRUSH_DETECTION {")).toBe(true);
        expect(line).not.toContain("\n");
        expect(JSON.parse(line.slice("THREATCRUSH_DETECTION ".length))).toEqual({
            v: 1, ip: "198.51.100.7", severity: "high", category: "app.rce_payload",
            source: "infernet", reason: "code in training", account: "u1"
        });
    });
});

describe("reportAttack", () => {
    it("logs the detection and bans the account", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        await reportAttack(req({ "x-forwarded-for": "198.51.100.7" }), { category: "app.rce_payload", reason: "x", userId: "u1" });
        expect(log.mock.calls[0][0]).toMatch(/^THREATCRUSH_DETECTION .*"ip":"198\.51\.100\.7"/);
        expect(updateUserById).toHaveBeenCalledWith("u1", { ban_duration: "876000h" });
    });
});
