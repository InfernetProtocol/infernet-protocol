import { describe, expect, it } from "vitest";
import { isAdminUser, safeNext, isSameOriginRequest } from "@/lib/auth/admin";

const h = (o) => new Headers(o);

describe("isAdminUser", () => {
    const env = { INFERNET_ADMIN_USER_IDS: "AAA-1, bbb-2", INFERNET_ADMIN_EMAILS: "boss@example.com" };

    it("matches a listed user id", () => {
        expect(isAdminUser({ id: "aaa-1" }, env)).toBe(true);
        expect(isAdminUser({ id: "ccc-3" }, env)).toBe(false);
    });

    it("matches a listed email only once it is confirmed", () => {
        expect(isAdminUser({ id: "x", email: "Boss@Example.com", email_confirmed_at: "2026-01-01" }, env)).toBe(true);
        expect(isAdminUser({ id: "x", email: "boss@example.com" }, env)).toBe(false);
    });

    it("nobody is an admin when nothing is configured", () => {
        expect(isAdminUser({ id: "aaa-1", email: "boss@example.com", email_confirmed_at: "x" }, {})).toBe(false);
        expect(isAdminUser(null, env)).toBe(false);
    });
});

describe("safeNext", () => {
    it("keeps same-site paths and refuses everything else", () => {
        expect(safeNext("/admin/payouts")).toBe("/admin/payouts");
        expect(safeNext("//evil.example")).toBe("/dashboard");
        expect(safeNext("/\\evil.example")).toBe("/dashboard");
        expect(safeNext("https://evil.example")).toBe("/dashboard");
        expect(safeNext(undefined)).toBe("/dashboard");
    });
});

describe("isSameOriginRequest", () => {
    it("trusts Sec-Fetch-Site when the browser sends it", () => {
        expect(isSameOriginRequest(h({ "sec-fetch-site": "same-origin" }))).toBe(true);
        expect(isSameOriginRequest(h({ "sec-fetch-site": "cross-site", origin: "https://infernetprotocol.com", host: "infernetprotocol.com" }))).toBe(false);
    });

    it("otherwise compares Origin with Host", () => {
        expect(isSameOriginRequest(h({ origin: "https://infernetprotocol.com", host: "infernetprotocol.com" }))).toBe(true);
        expect(isSameOriginRequest(h({ origin: "https://evil.example", host: "infernetprotocol.com" }))).toBe(false);
        expect(isSameOriginRequest(h({}))).toBe(true);
    });
});
