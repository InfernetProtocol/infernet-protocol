import { NextResponse } from "next/server";
import { requestUser, isFormPost } from "@/lib/auth/request-user";
import { revokeInvite, InviteError } from "@/lib/credits";
import { publicOrigin } from "@/lib/credits/core";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/invites/{id} — withdraw one of your unused invites (refunds the slot).
 * POST does the same for the form on /invites.
 */
async function revoke(request, { params }) {
    const form = isFormPost(request);
    const origin = publicOrigin(request);
    const user = await requestUser(request);
    if (!user) {
        return form
            ? NextResponse.redirect(new URL("/auth/login?next=/invites", origin), 303)
            : NextResponse.json({ error: "sign in required" }, { status: 401 });
    }
    const { id } = await params;
    try {
        await revokeInvite(user.id, String(id));
        return form ? NextResponse.redirect(new URL("/invites?revoked=1", origin), 303) : NextResponse.json({ ok: true });
    } catch (err) {
        const status = err instanceof InviteError ? err.status : 500;
        const message = err instanceof InviteError ? err.message : "Could not withdraw that invite.";
        return form
            ? NextResponse.redirect(new URL(`/invites?${new URLSearchParams({ error: message })}`, origin), 303)
            : NextResponse.json({ error: message }, { status });
    }
}

export const DELETE = revoke;
export const POST = revoke;
