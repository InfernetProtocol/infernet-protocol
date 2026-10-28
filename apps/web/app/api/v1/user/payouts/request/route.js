import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { getUserProviders } from "@/lib/data/dashboard";
import { requestPayout } from "@/lib/data/earnings";
import { appUrl } from "@/lib/auth/app-url";

/**
 * POST /api/v1/user/payouts/request  (form from /dashboard)
 *   provider_id   a node the signed-in user owns (checked via pubkey_links)
 *   amount_usd    optional; empty = the whole available balance
 *
 * Queues the withdrawal for admin approval (or sends it now when it is within
 * the auto-approve amount) and redirects back.
 */
export async function POST(request) {
    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.redirect(new URL("/auth/login?next=/dashboard", appUrl()), 303);
    }
    const form = await request.formData();
    const providerId = String(form.get("provider_id") ?? "");
    const rawAmount = String(form.get("amount_usd") ?? "").trim();
    const back = (params) => NextResponse.redirect(new URL(`/dashboard?${new URLSearchParams(params)}#earnings`, appUrl()), 303);

    const owned = await getUserProviders(user.id);
    if (!owned.some((p) => p.id === providerId)) {
        return back({ payout_error: "That node is not linked to your account." });
    }
    try {
        const out = await requestPayout({ providerId, amountUsd: rawAmount ? Number(rawAmount) : null, via: "dashboard" });
        return back({ payout: out.request?.status === "sent" ? "sent" : "requested" });
    } catch (err) {
        return back({ payout_error: err.message });
    }
}
