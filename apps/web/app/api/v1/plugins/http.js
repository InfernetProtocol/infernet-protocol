import "server-only";
import { fail } from "@/lib/reservations/http";
import { requestUser } from "@/lib/auth/request-user";

export async function signedIn(request) {
    const user = await requestUser(request);
    return user ? { user } : { error: fail(401, "Sign in first (the site, or `infernet login`) to use plugins.") };
}

export function failFrom(e) {
    const status = Number.isInteger(e?.status) ? e.status : 500;
    if (status >= 500) console.error("[plugins]", e?.message ?? e);
    return fail(status, e?.message ?? String(e));
}
