import { finishConnect } from "@/lib/plugins/store";
import { cookieFrom } from "@/lib/auth/request-user";
import { pluginResultPage, STATE_COOKIE } from "../result-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/plugins/callback?code&state: the OAuth redirect_uri for every
 * plugin. Finishes sign-in, then tells the opener (the /chat popup) and closes,
 * or shows a page to return to chat.
 */
export async function GET(request) {
    const url = new URL(request.url);
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
        const desc = url.searchParams.get("error_description");
        return pluginResultPage({ ok: false, message: `Sign-in was not completed: ${desc || oauthError}` }, 400);
    }
    const state = url.searchParams.get("state");
    if (!state || cookieFrom(request, STATE_COOKIE) !== state) {
        return pluginResultPage({ ok: false, message: "Finish signing in in the same browser you started it from (open the plugin's sign-in link again)." }, 400);
    }
    try {
        const r = await finishConnect({ state, code: url.searchParams.get("code") });
        return pluginResultPage({ ok: true, slug: r.slug, name: r.name, tools: r.tools, returnTo: r.returnTo });
    } catch (e) {
        return pluginResultPage({ ok: false, message: e?.message ?? String(e) }, Number.isInteger(e?.status) ? e.status : 500);
    }
}
