import { NextResponse } from "next/server";
import { listChatModels } from "@/lib/data/chat";
import { bearerFrom, isReservationKey } from "@/lib/reservations/core";
import { serveModels } from "@/lib/reservations/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OpenAI-compatible model list. Wraps listChatModels() (which
 * aggregates specs.served_models across online providers) in OpenAI's
 * documented response shape:
 *
 *   { object: "list", data: [{ id, object, owned_by, created, ... }] }
 *
 * `id` is the model name a caller passes back as `model` in
 * /v1/chat/completions. `owned_by` is "infernet" because we don't
 * track per-provider ownership in the model identity here — model
 * routing happens server-side at job-creation time.
 */
export async function GET(request) {
    // A reservation key sees exactly its reserved models.
    const presented = bearerFrom(request?.headers?.get("authorization"));
    if (isReservationKey(presented)) return serveModels(presented);

    let models;
    try {
        models = await listChatModels();
    } catch (e) {
        return NextResponse.json(
            { error: { message: e?.message ?? String(e), type: "infernet_error" } },
            { status: 500 }
        );
    }

    const created = Math.floor(Date.now() / 1000);
    return NextResponse.json({
        object: "list",
        data: (models ?? []).map((m) => ({
            id: m.name,
            object: "model",
            created,
            owned_by: "infernet"
        }))
    });
}
