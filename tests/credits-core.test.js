import { describe, it, expect, afterEach } from "vitest";
import {
    mailboxKey,
    isThrowawayEmail,
    bonusDenyReason,
    parseMintInput,
    publicOrigin,
    inviteUrl,
    refUrl,
    inviteStatus,
    inviteBonusCredits,
    INVITE_BONUS_MONTHLY_CAP,
    DEFAULT_INVITE_BONUS_CREDITS,
    CREDIT_UNIT
} from "../apps/web/lib/credits/core.js";

const h = (o) => ({ get: (k) => o[k] ?? null });

describe("credits core", () => {
    afterEach(() => {
        delete process.env.INFERNET_INVITE_BONUS_CREDITS;
        delete process.env.NEXT_PUBLIC_APP_URL;
    });

    it("mailboxKey folds +tags, case and gmail dots", () => {
        expect(mailboxKey("A.B+x@GMail.com")).toBe("ab@gmail.com");
        expect(mailboxKey("a.b@googlemail.com")).toBe("ab@gmail.com");
        expect(mailboxKey("a.b+y@example.com")).toBe("a.b@example.com");
        expect(mailboxKey("nope")).toBeNull();
    });

    it("flags throwaway domains and their subdomains", () => {
        expect(isThrowawayEmail("x@mailinator.com")).toBe(true);
        expect(isThrowawayEmail("x@sub.yopmail.com")).toBe(true);
        expect(isThrowawayEmail("x@example.com")).toBe(false);
    });

    it("denies the bonus for the same mailbox, throwaway mail and the monthly cap", () => {
        const ok = { invitee: { email: "a@x.com" }, inviter: { email: "b@x.com" }, inviterBonuses30d: 0 };
        expect(bonusDenyReason(ok)).toBeNull();
        expect(bonusDenyReason({ ...ok, invitee: { email: "B+2@x.com" } })).toBe("same_mailbox");
        expect(bonusDenyReason({ ...ok, invitee: { email: "a@mailinator.com" } })).toBe("throwaway_domain");
        expect(bonusDenyReason({ ...ok, inviterBonuses30d: INVITE_BONUS_MONTHLY_CAP })).toBe("monthly_cap");
        expect(bonusDenyReason({ ...ok, inviter: null })).toBe("unknown_account");
    });

    it("parses mint input into a consumer credits grant", () => {
        const r = parseMintInput({ credits: 500, label: "Preshy", max_redemptions: 2 });
        expect(r.ok).toBe(true);
        expect(r.value.grant).toEqual({ unit: CREDIT_UNIT, amount: 500 });
        expect(r.value.maxRedemptions).toBe(2);
        expect(parseMintInput({ credits: 10, monthly: true }).value.grant.every).toBe("month");
        expect(parseMintInput({ credits: 0 }).ok).toBe(false);
        expect(parseMintInput({ credits: 1.5 }).ok).toBe(false);
        expect(parseMintInput({ credits: 5, expires_at: "garbage" }).ok).toBe(false);
        expect(parseMintInput({ credits: 5, expires_at: "2027-01-01" }).value.expiresAt).toBe(Date.parse("2027-01-01"));
    });

    it("builds links from the configured or request host, never localhost", () => {
        process.env.NEXT_PUBLIC_APP_URL = "http://localhost:8080";
        expect(publicOrigin({ headers: h({ host: "infernetprotocol.com", "x-forwarded-proto": "https" }) })).toBe("https://infernetprotocol.com");
        expect(publicOrigin({ headers: h({ host: "localhost:3227" }) })).toBe("https://infernetprotocol.com");
        process.env.NEXT_PUBLIC_APP_URL = "https://infernetprotocol.com/";
        expect(publicOrigin({ headers: h({ host: "localhost:3227" }) })).toBe("https://infernetprotocol.com");
        expect(inviteUrl("https://a.b/", "INV-1")).toBe("https://a.b/i/INV-1");
        expect(refUrl("https://a.b", "ABC")).toBe("https://a.b/?ref=ABC");
    });

    it("invite status and the bonus env override", () => {
        expect(inviteStatus({ usedBy: "u" }, 0)).toBe("used");
        expect(inviteStatus({ revokedAt: 1 }, 0)).toBe("revoked");
        expect(inviteStatus({ expiresAt: 5 }, 10)).toBe("expired");
        expect(inviteStatus({ expiresAt: null }, 10)).toBe("open");
        expect(inviteBonusCredits()).toBe(DEFAULT_INVITE_BONUS_CREDITS);
        process.env.INFERNET_INVITE_BONUS_CREDITS = "250";
        expect(inviteBonusCredits()).toBe(250);
    });
});
