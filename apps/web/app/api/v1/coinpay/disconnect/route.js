import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isSameOriginRequest } from "@/lib/auth/admin";
import { appUrl } from "@/lib/auth/app-url";
import { disconnectCoinpay, supabaseCoinpayStore } from "@/lib/auth/coinpay-signin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/coinpay/disconnect : refused when CoinPay is the only way in. */
export async function POST(request) {
    if (!isSameOriginRequest(request.headers)) return new NextResponse("Cross-site request refused.", { status: 403 });
    const user = await getCurrentUser();
    if (!user) return NextResponse.redirect(new URL("/auth/login?next=/settings", appUrl()), 303);
    const r = await disconnectCoinpay(user.id, user.email ?? null, supabaseCoinpayStore(getSupabaseServerClient()));
    const url = new URL("/settings", appUrl());
    if (r.ok) url.searchParams.set("coinpay", "disconnected");
    else url.searchParams.set("error", r.error);
    url.hash = "coinpay";
    return NextResponse.redirect(url, 303);
}
