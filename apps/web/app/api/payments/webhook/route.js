import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { confirmPaidJobCredits } from "@/lib/data/earnings";
import { orderByPaymentRef, getOrder, fulfilOrder } from "@/lib/data/reservation-orders";
import {
  verifyWebhookSignature,
  parseWebhookPayload,
  WEBHOOK_SIGNATURE_HEADER
} from "@infernetprotocol/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status, error, detail) {
  const body = { error };
  if (detail !== undefined) body.detail = detail;
  return NextResponse.json(body, { status });
}

/**
 * POST /api/payments/webhook  (CoinPay business webhook)
 *
 * Verifies X-CoinPay-Signature over the raw body, then settles the job the
 * payment belongs to: by the CoinPay id stored at checkout first (crypto
 * confirmations and PayPal events carry only that), then metadata.order_id.
 * A confirmed job is never moved back to pending or failed by a later event.
 */
export async function POST(request) {
  // Always read the raw body: signature verification depends on byte-exact input.
  const rawBody = await request.text();
  const signature = request.headers.get(WEBHOOK_SIGNATURE_HEADER);

  let valid = false;
  try {
    valid = verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    return errorResponse(500, "Webhook verification failed", err.message);
  }
  if (!valid) {
    return errorResponse(401, "Invalid webhook signature");
  }

  let event;
  try {
    event = parseWebhookPayload(rawBody);
  } catch (err) {
    return errorResponse(400, "Malformed webhook payload", err.message);
  }

  const supabase = getSupabaseServerClient();

  // 1. Find the job.
  const refs = [event.paymentId, event.checkoutSessionId].filter(Boolean).map(String);
  let job = null;
  if (refs.length > 0) {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, payment_status, payment_invoice")
      .in("payment_invoice", refs)
      .limit(1)
      .maybeSingle();
    if (error) return errorResponse(500, "Failed to look up job", error.message);
    job = data;
  }
  if (!job && event.orderId) {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, payment_status, payment_invoice")
      .eq("id", String(event.orderId))
      .maybeSingle();
    if (error) return errorResponse(500, "Failed to look up job", error.message);
    job = data;
  }
  if (!job) {
    // Not a job: maybe a self-serve reservation order (POST /api/v1/orders, pay: "checkout").
    try {
      const order = (await orderByPaymentRef(refs)) ?? (event.orderId ? await getOrder(String(event.orderId)) : null);
      if (order) {
        if (event.status !== "confirmed") {
          return NextResponse.json({ ok: true, settled: false, reason: `order ${order.id}: status ${event.providerStatus || event.status}` });
        }
        const done = await fulfilOrder(order);
        return NextResponse.json({ ok: true, settled: true, orderId: order.id, reservationId: done.order?.reservation_id ?? null });
      }
    } catch (err) {
      return errorResponse(500, "Failed to settle reservation order", err?.message ?? String(err));
    }
    // Not ours (or a test event): acknowledge so CoinPay stops retrying.
    return NextResponse.json({ ok: true, settled: false, reason: "unknown payment" });
  }

  if (job.payment_status === "confirmed" && event.status !== "confirmed") {
    return NextResponse.json({ ok: true, settled: false, reason: "already confirmed" });
  }
  if (event.status === "pending") {
    return NextResponse.json({ ok: true, settled: false, reason: `status ${event.providerStatus || "pending"}` });
  }

  const invoiceId = job.payment_invoice ?? refs[0] ?? null;
  const now = new Date().toISOString();

  // 2. Ledger row for this checkout.
  if (invoiceId) {
    const txUpdate = { status: event.status };
    if (event.txHash) txUpdate.tx_hash = event.txHash;
    if (event.status === "confirmed") txUpdate.confirmed_at = now;
    const { error: txErr } = await supabase
      .from("payment_transactions")
      .update(txUpdate)
      .eq("invoice_id", invoiceId)
      .neq("status", "confirmed");
    if (txErr) {
      return errorResponse(500, "Failed to update payment transaction", txErr.message);
    }
  }

  // 3. The job itself: this is the fulfilment.
  const jobUpdate = { payment_status: event.status };
  if (event.status === "confirmed" && event.txHash) jobUpdate.payment_tx_hash = event.txHash;
  const { error: jobErr } = await supabase.from("jobs").update(jobUpdate).eq("id", job.id);
  if (jobErr) {
    return errorResponse(500, "Failed to update job payment status", jobErr.message);
  }

  // 4. The serving providers' credits for this job are now real money.
  if (event.status === "confirmed") {
    try {
      await confirmPaidJobCredits(job.id, supabase);
    } catch (err) {
      console.warn(`confirmPaidJobCredits failed: ${err?.message ?? err}`);
    }
  }

  return NextResponse.json({ ok: true, settled: event.status === "confirmed", jobId: job.id });
}
