/**
 * Job invoices (POST /api/payments/invoice): the pure rules.
 *
 * A job belongs to its client (jobs.client_id -> clients.public_key). The
 * caller is that client when its signed request carries the client's pubkey,
 * or a signed-in user who linked that pubkey (pubkey_links, role 'client').
 * A job with no client has no owner who could invoice it.
 */

/** Hosted checkouts are opened for 60 minutes; one older than that is not reused. */
export const CHECKOUT_TTL_MS = 60 * 60 * 1000;

/** Whether the caller may invoice this job. */
export function isJobOwner({ client, signedPubkey = null, linkedPubkeys = [] } = {}) {
    const key = client?.public_key;
    if (!key) return false;
    if (signedPubkey && signedPubkey === key) return true;
    return (linkedPubkeys ?? []).includes(key);
}

/**
 * The open checkout already made for this job, if it can still be paid:
 * the pending inbound ledger row for the job's current payment_invoice,
 * not yet expired. Returns the invoice response fields or null.
 */
export function reusableCheckout(job, tx, now = Date.now()) {
    if (!job?.payment_invoice || job.payment_status !== "invoiced") return null;
    if (!tx || tx.invoice_id !== job.payment_invoice || tx.status !== "pending") return null;
    const meta = tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
    const url = meta.hosted_url ?? null;
    if (!url) return null;
    const expires = Date.parse(meta.expires_at ?? "");
    if (Number.isFinite(expires)) {
        if (expires <= now) return null;
    } else {
        const created = Date.parse(tx.created_at ?? "");
        if (!Number.isFinite(created) || now - created >= CHECKOUT_TTL_MS) return null;
    }
    return {
        invoiceId: tx.invoice_id,
        rail: meta.rail ?? null,
        payAddress: tx.address && tx.address !== meta.rail ? tx.address : null,
        amount: Number(tx.amount),
        amountUsd: Number(tx.amount_usd),
        coin: tx.coin ?? null,
        expiresAt: meta.expires_at ?? null,
        hostedUrl: url,
        paymentUrl: url,
        reused: true
    };
}
