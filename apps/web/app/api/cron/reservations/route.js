import { NextResponse } from "next/server";
import { activeReservations, recordProbe, getReservation, endpointApiKey, updateReservation } from "@/lib/data/reservations";
import { probe } from "@/lib/data/reservation-upstream";
import { rentalOrdersToTend, setRentalRef, setRentalState } from "@/lib/data/reservation-orders";
import { provisionRental, startRental, serveRental, deleteRental } from "@/lib/data/rental";
import { rentalAction } from "@/lib/reservations/rental";

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
 * It also runs the rented GPUs behind rented orders (lib/data/rental.js):
 * rent or start one an hour before its window, point the reservation at it
 * once it answers, and give it back when the window ends. Every provider —
 * SaladCloud, Vast.ai, Thunder Compute — goes through the same four verbs.
 */
async function tendRentals(now) {
    let orders;
    try {
        orders = await rentalOrdersToTend();
    } catch (e) {
        // Before the rental columns exist this is the only thing that fails; probing goes on.
        return [{ error: e?.message ?? String(e) }];
    }
    return Promise.all(orders.map(async (o) => {
        const action = rentalAction(o, now.getTime());
        if (!action) return null;
        const provider = o.rental_provider;
        try {
            if (action === "rent") {
                const made = await provisionRental({ orderId: o.id, gpuClass: o.gpu_class, model: o.models?.[0] });
                await setRentalRef(o.id, { provider: made.provider, ref: made.ref, state: made.state, saladGroup: made.ref });
                // The key is generated here but only needed once the box answers,
                // so it is stored on the reservation now rather than held in memory.
                if (made.apiKey && o.reservation_id) {
                    await updateReservation(o.reservation_id, { endpoint_api_key: made.apiKey });
                }
                return { order: o.id, action, provider, ref: made.ref };
            }
            if (action === "start") {
                await startRental({ provider, ref: o.rental_ref });
                await setRentalState(o.id, "started");
                return { order: o.id, action, provider };
            }
            if (action === "serve") {
                const res = o.reservation_id ? await getReservation(o.reservation_id) : null;
                const served = await serveRental({
                    provider, ref: o.rental_ref, model: o.models?.[0],
                    apiKey: res ? endpointApiKey(res) : null
                });
                if (!served.ready) return { order: o.id, action, provider, waiting: true };
                if (served.url && o.reservation_id) await updateReservation(o.reservation_id, { endpoint_url: served.url });
                await setRentalState(o.id, "started");
                return { order: o.id, action, provider, serving: true };
            }
            await deleteRental({ provider, ref: o.rental_ref });
            await setRentalState(o.id, "deleted");
            return { order: o.id, action, provider };
        } catch (e) {
            // Salad refuses to start a group it is still preparing (status Pending); the next minute retries.
            if (action === "start" && /current_status|Pending/.test(e?.message ?? "")) return { order: o.id, action, provider, waiting: "pending" };
            // A rented box that can never come up is given back now rather than
            // billing for the whole window while the cron waits on it.
            if (e?.vastDead || e?.thunderDead) {
                await deleteRental({ provider, ref: o.rental_ref }).catch(() => {});
                await setRentalState(o.id, "deleted", `${provider} ${action}: ${e?.message ?? e}`).catch(() => {});
                return { order: o.id, action, provider, error: e?.message ?? String(e), gave_back: true };
            }
            console.error(`[reservations] ${provider} ${action} ${o.rental_ref ?? "-"} failed: ${e?.message ?? e}`);
            await setRentalState(o.id, o.rental_state, `${provider} ${action}: ${e?.message ?? e}`).catch(() => {});
            return { order: o.id, action, provider, error: e?.message ?? String(e) };
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
        const rentals = await tendRentals(now);
        const list = await activeReservations(now);
        const results = await Promise.all(list.map(async (res) => {
            const verdict = await probe(res, now.getTime());
            await recordProbe(res.id, now, verdict);
            return { id: res.id, ok: verdict.ok, latency_ms: verdict.latency_ms, detail: verdict.detail };
        }));
        const failed = results.filter((r) => !r.ok);
        if (failed.length) console.warn(`[reservations] ${failed.length}/${results.length} probes failed`, failed);
        return NextResponse.json({ data: { minute: now.toISOString(), probed: results.length, results, rentals } });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[reservations cron]", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
