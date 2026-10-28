import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
const bytesToBase64 = (b) => Buffer.from(b).toString("base64");

// One row table standing in for public.operator_secrets.
let row = null;
const fake = {
    from() {
        const q = {
            select() { return q; },
            eq() { return q; },
            maybeSingle: async () => ({ data: row, error: null }),
            insert: async (r) => { row = { ...r }; return { error: null }; },
            update(patch) { return { eq: async () => { row = { ...row, ...patch }; return { error: null }; } }; }
        };
        return q;
    }
};
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fake }));

const vault = await import("../apps/web/lib/operator-vault.js");
const payments = await import("../packages/payments/src/coinpayportal.js");

describe("operator vault: the payout key is sealed and opened only while unlocked", () => {
    let made;
    beforeEach(async () => {
        row = null;
        vault.resetOperatorVaultForTests();
        made = await vault.sealer.createSeal("operator passphrase", "operator");
        await vault.createVault(made.seal);
    });

    it("locked: no payout key, with a 423 and one alert line", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        await expect(vault.payoutKey()).rejects.toMatchObject({ status: 423 });
        await expect(vault.payoutKey()).rejects.toMatchObject({ status: 423 });
        expect(spy.mock.calls.filter(([l]) => String(l).startsWith("[alert]"))).toHaveLength(1);
        spy.mockRestore();
    });

    it("a wrong key does not unlock; the right one does, for 7 days by default", async () => {
        await expect(vault.unlock(bytesToBase64(randomBytes(32)))).rejects.toMatchObject({ status: 403 });
        const out = await vault.unlock(bytesToBase64(made.dek));
        const days = (new Date(out.expiresAt).getTime() - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(6.9);
        expect(days).toBeLessThanOrEqual(7);
    });

    it("seals the key (never stored in the clear), opens it while unlocked, forgets it on lock and restart", async () => {
        await vault.unlock(bytesToBase64(made.dek), "1h");
        await vault.setPayoutKey("cp_live_payout_key_123");
        expect(JSON.stringify(row)).not.toContain("cp_live_payout_key_123");
        expect(await vault.payoutKey()).toBe("cp_live_payout_key_123");
        vault.lock();
        await expect(vault.payoutKey()).rejects.toMatchObject({ status: 423 });
        await vault.unlock(bytesToBase64(made.dek), "1h");
        vault.resetOperatorVaultForTests(); // a restart
        await expect(vault.payoutKey()).rejects.toMatchObject({ status: 423 });
    });

    it("payouts never fall back to the environment key", async () => {
        process.env.COINPAY_API_KEY = "env-key-that-must-not-be-used";
        await expect(
            payments.createPayout({ recipientWallet: "0xabc", amountUsd: 1, cryptocurrency: "USDC_POL" })
        ).rejects.toThrow(/operator payout key is required/);
        delete process.env.COINPAY_API_KEY;
    });
});
