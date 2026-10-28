import { NextResponse } from "next/server";
import { activeReservations, recordProbe } from "@/lib/data/reservations";
import { probe } from "@/lib/data/reservation-upstream";
import { saladOrdersToTend, setSaladState } from "@/lib/data/reservation-orders";
import { startGroup, deleteGroup } from "@/lib/data/salad";
import { lifecycleAction } from "@/lib/reservations/salad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron: probe the pinned target of every reservation whose window is open and
 * write one row per reservation-minute — whether or not anyone sent traffic.
 * Those rows are the availability evidence the per-hour report is built from.
 * Run every minute from dev2's crontab:
 *
 *   * * * * * curl -fsS -m 55 -X POST https://infernetprotocol.com/api/cron/reservations \
 *        -H "Authorization: Bearer $CRON_SECRET"
 *
 * A minute the cron misses has no row and counts as unconfirmed.
 *
 * It also runs the SaladCloud container groups behind Salad orders: start one
 * an hour before its window, delete it when the window ends.
 */
async function tendSalad(now) {
    let orders;
    try {
        orders = await saladOrdersToTend();
    } catch (e) {
        // Before the salad columns exist this is the only thing that fails; probing goes on.
        return [{ error: e?.message ?? String(e) }];
    }
    return Promise.all(orders.map(async (o) => {
        const action = lifecycleAction(o, now.getTime());
        if (!action) return null;
        try {
            if (action === "start") {
                await startGroup(o.salad_group);
                await setSaladState(o.id, "started");
            } else {
                await deleteGroup(o.salad_group);
                await setSaladState(o.id, "deleted");
            }
            return { order: o.id, action };
        } catch (e) {
            // Salad refuses to start a group it is still preparing (status Pending); the next minute retries.
            if (action === "start" && /current_status|Pending/.test(e?.message ?? "")) return { order: o.id, action, waiting: "pending" };
            console.error(`[reservations] salad ${action} ${o.salad_group} failed: ${e?.message ?? e}`);
            await setSaladState(o.id, o.salad_state, `salad ${action}: ${e?.message ?? e}`).catch(() => {});
            return { order: o.id, action, error: e?.message ?? String(e) };
        }
    })).then((r) => r.filter(Boolean));
}

function authorized(request) {
    const expected = process.env.CRON_SECRET;
    if (!expected) return false;
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const given = request.headers.get("x-cron-secret") || bearer;
    return Boolean(given) && given === expected;
}

export async function POST(request) {
    if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const now = new Date();
    try {
        const salad = await tendSalad(now);
        const list = await activeReservations(now);
        const results = await Promise.all(list.map(async (res) => {
            const verdict = await probe(res, now.getTime());
            await recordProbe(res.id, now, verdict);
            return { id: res.id, ok: verdict.ok, latency_ms: verdict.latency_ms, detail: verdict.detail };
        }));
        const failed = results.filter((r) => !r.ok);
        if (failed.length) console.warn(`[reservations] ${failed.length}/${results.length} probes failed`, failed);
        return NextResponse.json({ data: { minute: now.toISOString(), probed: results.length, results, salad } });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[reservations cron]", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
