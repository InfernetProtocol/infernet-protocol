/**
 * Did CoinPay really collect enough for this order?
 *
 * The webhook body and the buyer's poll are both only a hint: before an order
 * is fulfilled we ask CoinPay itself and compare what it collected with the
 * order total. Pure apart from the injected clients, so it is unit-testable.
 *
 * Returns "paid", "unpaid" or "unknown" (CoinPay could not be asked). Callers
 * fulfil only on "paid"; the webhook answers "unknown" with a 5xx so CoinPay
 * retries it.
 */

const PAID_STATUSES = new Set(["confirmed", "completed", "forwarded", "paid"]);

/** True when `paidCents` covers `totalUsd`, to the cent. */
export function coversTotal(paidCents, totalUsd) {
    const need = Math.round(Number(totalUsd) * 100);
    const got = Number(paidCents);
    return Number.isFinite(need) && need > 0 && Number.isFinite(got) && got >= need;
}

/** USD cents a CoinPay payment record says it collected, or null when it does not say. */
export function paymentUsdCents(payment) {
    const raw = payment?.amount_usd ?? payment?.amountUsd ?? payment?.usd_amount ?? null;
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** The chain tx hash a CoinPay session or payment record carries, or null. */
export function txHashOf(record) {
    const r = record && typeof record === "object" ? record : {};
    const v = r.tx_hash ?? r.txHash ?? r.merchant_tx_hash ?? r.transaction_hash ?? r.payment?.tx_hash ?? null;
    return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
}

/**
 * @param {string} ref       checkout session id or payment id
 * @param {number} totalUsd  the order total
 * @param {{ getSession?: (ref:string)=>Promise<any>, sessionState?: (s:any)=>{paid:boolean,cents:number|null},
 *           getPayment?: (ref:string)=>Promise<any> }} deps
 * @returns {Promise<{ verdict: "paid"|"unpaid"|"unknown", txHash: string|null }>}
 */
export async function verifyOrderPaymentDetail(ref, totalUsd, { getSession, sessionState, getPayment } = {}) {
    if (!ref) return { verdict: "unpaid", txHash: null };
    let asked = false;
    let txHash = null;
    if (getSession && sessionState) {
        try {
            const session = await getSession(ref);
            asked = true;
            if (session) {
                const st = sessionState(session);
                if (!st?.paid) return { verdict: "unpaid", txHash: null };
                txHash = txHashOf(session);
                // A paid session that does not report cents is only trusted
                // when the payment record below confirms the amount.
                if (st.cents !== null && st.cents !== undefined) {
                    return { verdict: coversTotal(st.cents, totalUsd) ? "paid" : "unpaid", txHash };
                }
            }
        } catch {
            /* not a session id, or CoinPay is down: try it as a payment */
        }
    }
    if (getPayment) {
        try {
            const p = await getPayment(ref);
            asked = true;
            if (!p) return { verdict: "unpaid", txHash: null };
            if (!PAID_STATUSES.has(String(p.status ?? "").toLowerCase())) return { verdict: "unpaid", txHash: null };
            const cents = paymentUsdCents(p);
            return { verdict: cents !== null && coversTotal(cents, totalUsd) ? "paid" : "unpaid", txHash: txHashOf(p) ?? txHash };
        } catch {
            /* fall through */
        }
    }
    return { verdict: asked ? "unpaid" : "unknown", txHash: null };
}

/** verifyOrderPaymentDetail's verdict alone: "paid" | "unpaid" | "unknown". */
export async function verifyOrderPayment(ref, totalUsd, deps = {}) {
    return (await verifyOrderPaymentDetail(ref, totalUsd, deps)).verdict;
}

/** An order whose booked hours are already over can only be refunded, never booked. */
export function orderWindowOver(order, now = Date.now()) {
    const start = Date.parse(order?.start_at ?? "");
    const hours = Number(order?.hours);
    if (!Number.isFinite(start) || !Number.isFinite(hours)) return false;
    return start + hours * 3600_000 <= now;
}
