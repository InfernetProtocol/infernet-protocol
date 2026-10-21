import { NextResponse } from "next/server";
import { listPaymentMethods } from "@infernetprotocol/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/payments/methods
 *
 * Every coin the CoinPay business takes, plus PayPal. `hosted: true` means
 * CoinPay shows the picker itself and POST /api/payments/invoice needs no
 * method.
 */
export async function GET() {
  try {
    return NextResponse.json(await listPaymentMethods());
  } catch (err) {
    return NextResponse.json(
      { error: "Payments are unavailable right now", detail: err.message },
      { status: 502 }
    );
  }
}
