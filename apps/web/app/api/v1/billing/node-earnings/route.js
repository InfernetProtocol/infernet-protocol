import { ok, fail } from "@/lib/reservations/http";
import { requireCaller, failFrom } from "@/lib/billing/http";
import { getEarningsBuckets, getC0mputeProviders } from "@/lib/data/earnings";
import { getUserProviders } from "@/lib/data/dashboard";
import { resolveEarningsSince, parseC0mputeNodeIds, c0mputeNodeOf, ownPayerIds } from "@/lib/earnings/core";
import { isAdminUser } from "@/lib/auth/admin";
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
 * own_jobs/own_usd: the part paid by the operator's own account (or, for an
 * admin, by any admin account): jobs they paid themselves, not income.
 *
 * A trusted client may add `c0mpute_nodes=<id>,<id>` (c0mpute board ids, the
 * last 8 characters of a peer id): the providers Infernet opened for those
 * c0mpute nodes (node_id `c0mpute:<peer>`) are included, each with
 * `c0mpute_node`. The client vouches that those nodes are the person's.
 *
 * Auth mirrors /api/v1/billing/balance: a trusted client names the person
 * with X-Infernet-Billed-Subject (their CoinPay sub), or a signed-in caller
 * reads their own.
 */
export async function GET(request) {
    const url = new URL(request.url);
    const since = url.searchParams.get("since");
    const c0mputeNodes = parseC0mputeNodeIds(url.searchParams.get("c0mpute_nodes"));
    const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
    const subject = await billedSubjectFrom(request, trusted);
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
            return ok(await earningsFor(userId, since, c0mputeNodes));
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

async function earningsFor(userId, since, c0mputeNodes = []) {
    const own = await getUserProviders(userId, { includeArchived: true });
    const bridged = c0mputeNodes.length ? await getC0mputeProviders(c0mputeNodes) : [];
    const providers = [...own, ...bridged.filter((b) => !own.some((p) => p.id === b.id))];
    const ownPayers = ownPayerIds(userId, {
        isAdmin: isAdminUser({ id: userId }),
        adminIds: String(process.env.INFERNET_ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim())
    });
    const { since: from, buckets } = await getEarningsBuckets(providers.map((p) => p.id), { since, ownPayers });
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
            archived_at: p.archived_at ?? null,
            c0mpute_node: c0mputeNodeOf(p.node_id)
        })),
        buckets
    };
}
