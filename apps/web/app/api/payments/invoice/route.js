import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { createCheckout, toCoinpayMethod } from "@infernetprotocol/payments";
import { maybeVerifySignedNextRequest, parseJsonBody } from "@/lib/auth/verify-signed-request";
import { requestUser } from "@/lib/auth/request-user";
import { isSameOriginRequest } from "@/lib/auth/admin";
import { adminActor } from "@/lib/reservations/http";
import { isJobOwner, reusableCheckout } from "@/lib/payments/invoice";

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
 *
 * Only the job's owner may invoice it: a request signed (X-Infernet-Auth) by
 * the job's client pubkey, or a signed-in user (CLI bearer, or the site
 * cookie on a same-origin request) who linked that client pubkey. An open
 * checkout for the job is returned again instead of opening another, and
 * CoinPay gets idempotency key job:<id> so a retry cannot open a second one.
 */
export async function POST(request) {
  let payload;
  let signedPubkey = null;
  try {
    const signed = await maybeVerifySignedNextRequest(request);
    if (signed) {
      signedPubkey = signed.pubkey;
      payload = parseJsonBody(signed.body);
    } else {
      payload = await request.json();
    }
  } catch (err) {
    if (err?.status === 401) return errorResponse(401, "Invalid signed request", err.message);
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
    .select("id, title, client_id, payment_offer, payment_status, payment_invoice")
    .eq("id", jobId)
    .maybeSingle();

  if (jobErr) {
    return errorResponse(500, "Failed to fetch job", jobErr.message);
  }
  if (!job) {
    return errorResponse(404, "Job not found", { jobId });
  }

  // 2. Only the job's owner (or an admin) may invoice it.
  if (!adminActor(request)) {
    let client = null;
    if (job.client_id) {
      const { data } = await supabase.from("clients").select("id, public_key").eq("id", job.client_id).maybeSingle();
      client = data ?? null;
    }
    let linkedPubkeys = [];
    if (!signedPubkey && client?.public_key) {
      const user = await requestUser(request);
      if (user && (user.via !== "cookie" || isSameOriginRequest(request.headers))) {
        const { data: links } = await supabase
          .from("pubkey_links")
          .select("pubkey")
          .eq("user_id", user.id)
          .eq("role", "client")
          .eq("pubkey", client.public_key);
        linkedPubkeys = (links ?? []).map((l) => l.pubkey);
      }
    }
    if (!isJobOwner({ client, signedPubkey, linkedPubkeys })) {
      return errorResponse(signedPubkey || linkedPubkeys.length ? 403 : 401, "Only the job's owner can invoice it");
    }
  }

  if (job.payment_status === "confirmed") {
    return errorResponse(409, "Job is already paid", { jobId });
  }

  // 3. A checkout already open for this job is handed back, not duplicated.
  if (job.payment_status === "invoiced" && job.payment_invoice) {
    const { data: tx } = await supabase
      .from("payment_transactions")
      .select("invoice_id, status, coin, amount, amount_usd, address, metadata, created_at")
      .eq("invoice_id", job.payment_invoice)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const open = reusableCheckout(job, tx);
    if (open) return NextResponse.json({ ...open, network: network ?? null });
  }

  const amountUsd = Number(job.payment_offer);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return errorResponse(400, "Job has no payment_offer set", { jobId });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://infernetprotocol.com").replace(/\/+$/, "");

  // 4. Open the checkout at CoinPay.
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
      cancelUrl: `${appUrl}/dashboard`,
      idempotencyKey: `job:${job.id}`
    });
  } catch (err) {
    const status = err.status && err.status < 500 ? 400 : 502;
    return errorResponse(status, "Failed to create checkout at CoinPay", err.message);
  }

  // 5. Point the job at the CoinPay id; the webhook settles by it.
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

  // 6. Inbound ledger row.
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

  // 7. Same field names as before, plus the rail and the URL to send the buyer to.
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
