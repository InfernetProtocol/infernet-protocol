import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/auth/app-url";

/**
 * POST /api/v1/user/settings
 *
 * Form-encoded body (from /settings):
 *   default_is_public      "true" | "false"
 *   node_public[<role>:<id>] "true" (presence = public; absence = private)
 *
 * Updates pubkey_links.default_is_public for the user, plus
 * is_public for each owned node role per the form. Only
 * touches rows the user actually owns (verified via pubkey_links).
 */
export async function POST(request) {
    const user = await getCurrentUser();
    if (!user) {
        return NextResponse.redirect(new URL("/auth/login?next=/settings", appUrl()), 303);
    }
    const form = await request.formData();
    const supabase = getSupabaseServerClient();

    try {
        const defaultIsPublic = form.get("default_is_public") === "true";
        await supabase
            .from("pubkey_links")
            .update({ default_is_public: defaultIsPublic })
            .eq("user_id", user.id);

        // Resolve nodes from the owner's pubkey links. Never trust ids from
        // the form without checking that they belong to this account.
        const { data: ownedLinks } = await supabase
            .from("pubkey_links")
            .select("pubkey, role")
            .eq("user_id", user.id);
        if ((ownedLinks ?? []).length === 0) {
            return NextResponse.redirect(new URL("/settings?saved=1", appUrl()), 303);
        }

        const tables = { provider: "providers", aggregator: "aggregators", client: "clients" };
        const updates = [];
        for (const [role, table] of Object.entries(tables)) {
            const pubkeys = (ownedLinks ?? [])
                .filter((link) => link.role === role)
                .map((link) => link.pubkey);
            if (pubkeys.length === 0) continue;
            const { data: ownedNodes } = await supabase
                .from(table)
                .select("id")
                .in("public_key", pubkeys);
            for (const node of ownedNodes ?? []) {
                const ticked = form.get(`node_public[${role}:${node.id}]`) === "true";
                updates.push(
                    supabase
                        .from(table)
                        .update({ is_public: ticked })
                        .eq("id", node.id)
                );
            }
        }
        await Promise.all(updates);

        return NextResponse.redirect(new URL("/settings?saved=1", appUrl()), 303);
    } catch (err) {
        const msg = encodeURIComponent(err?.message ?? "save failed");
        return NextResponse.redirect(new URL(`/settings?error=${msg}`, appUrl()), 303);
    }
}
