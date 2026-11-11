import { ok } from "@/lib/reservations/http";
import { addPlugin, catalog, listPlugins } from "@/lib/plugins/store";
import { signedIn, failFrom } from "./http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/plugins               your plugins + the catalog
 * POST /api/v1/plugins { url }       add one: a URL (https://...) or a catalog slug
 *                                    ("c0mpute"). When it wants sign-in the answer
 *                                    carries connect_url: open it in a browser.
 * Signed-in user only (site cookie or `infernet login` bearer).
 */
export async function GET(request) {
    const { user, error } = await signedIn(request);
    if (error) return error;
    try {
        return ok({ plugins: await listPlugins(user), catalog: catalog() });
    } catch (e) {
        return failFrom(e);
    }
}

export async function POST(request) {
    const { user, error } = await signedIn(request);
    if (error) return error;
    let body = {};
    try { body = (await request.json()) ?? {}; } catch { /* empty */ }
    const input = body.url ?? body.slug ?? body.input;
    if (typeof input !== "string" || !input.trim()) return failFrom(Object.assign(new Error("url is required (a plugin URL or a catalog name)"), { status: 400 }));
    try {
        return ok(await addPlugin(user, input.trim().slice(0, 500)), 201);
    } catch (e) {
        return failFrom(e);
    }
}
