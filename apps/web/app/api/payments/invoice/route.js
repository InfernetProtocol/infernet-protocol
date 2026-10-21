import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { createCheckout, toCoinpayMethod } from "@infernetprotocol/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status, error, detail) {
  const body = { error };
  if (detail !== undefined) body.detail = detail;
  return NextResponse.json(body, { status });
}

/**
 * POST /api/payments/invoice  { jobId, coin?, network?, method?, email? }
 *
 * Opens a CoinPay checkout for a job. `method` (or `coin` + `network`) picks
 * a CoinPay coin (USDC_POL, BTC, ...) or "paypal"; GET /api/payments/methods
 * lists what is on offer. When CoinPay hosts checkout sessions the method is
 * optional and the buyer picks on CoinPay's page.
 *
 * The amount is the job's own payment_offer; the caller never sends one.
 */
export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const { jobId, coin, network, method, email } = payload ?? {};

  if (!jobId || typeof jobId !== "string") {
    return errorResponse(400, "jobId is required");
  }
  const chosen = toCoinpayMethod(method ?? coin, network);
  if ((method ?? coin) && !chosen) {
    return errorResponse(400, "Unsupported coin/network combination", {
      coin: coin ?? method,
      network: network ?? null
    });
  }
  const buyerEmail =
    typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
      ? email.trim()
      : null;

  const supabase = getSupabaseServerClient();

  // 1. Look up the job.
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, title, client_id, payment_offer, payment_status")
    .eq("id", jobId)
    .maybeSingle();

  if (jobErr) {
    return errorResponse(500, "Failed to fetch job", jobErr.message);
  }
  if (!job) {
    return errorResponse(404, "Job not found", { jobId });
  }
  if (job.payment_status === "confirmed") {
    return errorResponse(409, "Job is already paid", { jobId });
  }

  const amountUsd = Number(job.payment_offer);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return errorResponse(400, "Job has no payment_offer set", { jobId });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://infernetprotocol.com").replace(/\/+$/, "");

  // 2. Open the checkout at CoinPay.
  let checkout;
  try {
    checkout = await createCheckout({
      amountUsd,
      orderId: job.id,
      method: chosen ?? undefined,
      description: `Infernet job ${job.title ? `: ${String(job.title).slice(0, 80)}` : job.id}`,
      accountId: job.client_id ?? null,
      email: buyerEmail,
      metadata: { job_id: job.id },
      successUrl: `${appUrl}/dashboard?paid=${encodeURIComponent(job.id)}`,
      cancelUrl: `${appUrl}/dashboard`
    });
  } catch (err) {
    const status = err.status && err.status < 500 ? 400 : 502;
    return errorResponse(status, "Failed to create checkout at CoinPay", err.message);
  }

  // 3. Point the job at the CoinPay id; the webhook settles by it.
  const { error: jobUpdErr } = await supabase
    .from("jobs")
    .update({
      payment_coin: checkout.coin,
      payment_invoice: checkout.id,
      payment_status: "invoiced"
    })
    .eq("id", job.id);

  if (jobUpdErr) {
    return errorResponse(500, "Failed to update job with invoice", jobUpdErr.message);
  }

  // 4. Inbound ledger row.
  const { error: ledgerErr } = await supabase.from("payment_transactions").insert({
    direction: "inbound",
    job_id: job.id,
    client_id: job.client_id ?? null,
    coin: checkout.coin,
    network: checkout.rail === "crypto" ? checkout.coin : checkout.rail,
    amount: checkout.rail === "crypto" && checkout.cryptoAmount != null ? checkout.cryptoAmount : amountUsd,
    amount_usd: amountUsd,
    address: checkout.payAddress ?? checkout.rail,
    invoice_id: checkout.id,
    status: "pending",
    provider_gateway: "coinpayportal",
    metadata: {
      rail: checkout.rail,
      hosted_url: checkout.paymentUrl,
      expires_at: checkout.expiresAt ?? null,
      property: "infernetprotocol.com",
      account_id: job.client_id ?? null,
      email: buyerEmail
    }
  });

  if (ledgerErr) {
    return errorResponse(500, "Failed to record payment transaction", ledgerErr.message);
  }

  // 5. Same field names as before, plus the rail and the URL to send the buyer to.
  return NextResponse.json({
    invoiceId: checkout.id,
    rail: checkout.rail,
    payAddress: checkout.payAddress,
    amount: checkout.cryptoAmount ?? amountUsd,
    amountUsd,
    coin: checkout.coin,
    network: network ?? null,
    expiresAt: checkout.expiresAt,
    hostedUrl: checkout.paymentUrl,
    paymentUrl: checkout.paymentUrl
  });
}
