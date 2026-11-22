import { ok, fail } from "@/lib/reservations/http";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor } from "@/lib/trusted-clients";
import { getNetworkLeaderboard } from "@/lib/data/leaderboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/network/leaderboard   (trusted client keys only)
 *
 * Raw material for c0mpute.com/leaderboard: top earning providers, top
 * spending accounts, top referrers and the most served models, all time and
 * over 24h / 7d / 30d. Nobody is named: every person, provider and referrer
 * is an HMAC token keyed with the caller's own key (lib/leaderboard/core.js),
 * so the answer means nothing to anyone else, and c0mpute nodes keep their
 * public board id. Providers whose operator hid them are left out, and house
 * (admin) accounts are never ranked as customers. Rows are cached 5 minutes.
 *
 *   { data: { generated_at, currency, windows: { "24h"|"7d"|"30d"|"all": {
 *       providers: [{ c0mpute_node?, owner, provider, earned_usd, jobs }],
 *       spenders:  [{ who, spent_usd, jobs }],
 *       referrers: [{ who, commissions_usd, nodes }],
 *       models:    [{ model, jobs, output_tokens, users }],
 *       totals:    { spenders, spent_usd, billed_jobs, earning_providers, served_jobs, output_tokens } } } } }
 */
export async function GET(request) {
    const bearer = bearerFrom(request.headers.get("authorization"));
    if (!trustedClientFor(bearer)) return fail(401, "trusted client key required");
    const data = await getNetworkLeaderboard(bearer);
    if (!data) return fail(503, "earnings ledger unavailable");
    return ok(data);
}
