import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { getEarningsBuckets } from "@/lib/data/earnings";
import { getUserProviders } from "@/lib/data/dashboard";
import { resolveEarningsSince } from "@/lib/earnings/core";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, billedSubjectFrom } from "@/lib/trusted-clients";
import { userIdForCoinpaySubject } from "@/lib/data/interactive-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/billing/node-earnings?since=<ISO8601>
 * A node operator's provider earnings over time, in hourly UTC buckets per
 * provider, for charting earnings against spend (the c0mpute.com operator
 * dashboard). Read-only.
 *
 * `since` defaults to 24 hours ago and is clamped to at most 31 days back.
 *
 *   {
 *     linked: true,
 *     since, generated_at,
 *     providers: [{ id, name, node_id, public_key, status, archived_at }],
 *     buckets: [{ provider_id, at, jobs, amount_usd, fee_usd, gross_usd }]
 *   }
 *
 * amount_usd is the operator's NET credit (what they keep); fee_usd is the
 * house fee; gross_usd = amount_usd + fee_usd. Void rows (never to be paid)
 * and spent_on_compute rows (spend, not earnings) are excluded; pending and
 * pending_approval rows are included, as that money is still on its way.
 *
 * Auth mirrors /api/v1/billing/balance: a trusted client names the person
 * with X-Infernet-Billed-Subject (their CoinPay sub), or a signed-in caller
 * reads their own.
 */
export async function GET(request) {
    const since = new URL(request.url).searchParams.get("since");
    const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
    const subject = billedSubjectFrom(request, trusted);
    if (trusted && subject) {
        try {
            const userId = await userIdForCoinpaySubject(subject);
            if (!userId) {
                return ok({
                    linked: false,
                    since: resolveEarningsSince(since),
                    generated_at: new Date().toISOString(),
                    providers: [],
                    buckets: []
                });
            }
            return ok(await earningsFor(userId, since));
        } catch (e) {
            return failFrom(e);
        }
    }
    if (trusted && !subject) {
        return fail(400, "name the person with X-Infernet-Billed-Subject (their CoinPay sub)");
    }

    const { user, error } = await requireCaller(request);
    if (error) return error;
    try { return ok(await earningsFor(user.id, since)); } catch (e) { return failFrom(e); }
}

async function earningsFor(userId, since) {
    const providers = await getUserProviders(userId, { includeArchived: true });
    const { since: from, buckets } = await getEarningsBuckets(providers.map((p) => p.id), { since });
    return {
        linked: true,
        since: from,
        generated_at: new Date().toISOString(),
        // Public identifiers only: no address/port/specs.
        providers: providers.map((p) => ({
            id: p.id,
            name: p.name ?? null,
            node_id: p.node_id ?? null,
            public_key: p.public_key ?? null,
            status: p.status ?? null,
            archived_at: p.archived_at ?? null
        })),
        buckets
    };
}
