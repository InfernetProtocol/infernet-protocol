import { describe, expect, it } from "vitest";
import { coversTotal, paymentUsdCents, verifyOrderPayment, orderWindowOver } from "../apps/web/lib/reservations/payment-check.js";

const state = (s) => ({ paid: Boolean(s.paid), cents: s.cents ?? null });

describe("coversTotal", () => {
    it("needs at least the total, to the cent", () => {
        expect(coversTotal(1098, 10.98)).toBe(true);
        expect(coversTotal(1097, 10.98)).toBe(false);
        expect(coversTotal(5000, 10.98)).toBe(true);
        expect(coversTotal(null, 10.98)).toBe(false);
        expect(coversTotal(100, 0)).toBe(false);
    });
});

describe("paymentUsdCents", () => {
    it("reads USD fields only, never a crypto amount", () => {
        expect(paymentUsdCents({ amount_usd: "10.98" })).toBe(1098);
        expect(paymentUsdCents({ amount: 0.00012 })).toBe(null);
    });
});

describe("verifyOrderPayment", () => {
    it("is paid when the session is paid for the full total", async () => {
        const v = await verifyOrderPayment("cs_1", 10.98, { getSession: async () => ({ paid: true, cents: 1098 }), sessionState: state });
        expect(v).toBe("paid");
    });

    it("refuses an underpaid session", async () => {
        const v = await verifyOrderPayment("cs_1", 10.98, { getSession: async () => ({ paid: true, cents: 100 }), sessionState: state });
        expect(v).toBe("unpaid");
    });

    it("refuses an unpaid session", async () => {
        const v = await verifyOrderPayment("cs_1", 10.98, { getSession: async () => ({ paid: false, cents: 1098 }), sessionState: state });
        expect(v).toBe("unpaid");
    });

    it("needs the payment record's USD amount when the session has no cents", async () => {
        const deps = { getSession: async () => ({ paid: true }), sessionState: state };
        expect(await verifyOrderPayment("p_1", 10.98, { ...deps, getPayment: async () => ({ status: "confirmed", amount_usd: 10.98 }) })).toBe("paid");
        expect(await verifyOrderPayment("p_1", 10.98, { ...deps, getPayment: async () => ({ status: "confirmed", amount: 0.0002 }) })).toBe("unpaid");
    });

    it("is unknown when CoinPay cannot be reached, so the webhook is retried", async () => {
        const boom = async () => { throw new Error("ECONNREFUSED"); };
        expect(await verifyOrderPayment("cs_1", 10.98, { getSession: boom, sessionState: state, getPayment: boom })).toBe("unknown");
    });

    it("is unpaid with no reference", async () => {
        expect(await verifyOrderPayment(null, 10.98, {})).toBe("unpaid");
    });
});

describe("orderWindowOver", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    it("is over once start + hours has passed", () => {
        expect(orderWindowOver({ start_at: "2026-11-02T09:00:00Z", hours: 3 }, now)).toBe(true);
        expect(orderWindowOver({ start_at: "2026-11-02T10:00:00Z", hours: 3 }, now)).toBe(false);
    });
});
