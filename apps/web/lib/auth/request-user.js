import "server-only";
import { verifyBearerHeader } from "@/lib/auth/bearer";
import { getCurrentUser } from "@/lib/supabase/auth-server";

/**
 * The caller of an API route: a CLI bearer (`infernet login`) in the
 * Authorization header, or the Supabase session cookie. null = anonymous.
 */
export async function requestUser(request) {
    const claims = verifyBearerHeader(request.headers.get("authorization"));
    if (claims?.sub) return { id: claims.sub, email: claims.email ?? null, via: "bearer" };
    try {
        const user = await getCurrentUser();
        if (user?.id) return { id: user.id, email: user.email ?? null, via: "cookie" };
    } catch {
        /* anonymous */
    }
    return null;
}

/** True when the request came from an HTML form (redirect back) rather than JSON. */
export function isFormPost(request) {
    const ct = request.headers.get("content-type") ?? "";
    return ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data");
}

/** Body as a plain object from JSON or a form. */
export async function readBody(request) {
    if (isFormPost(request)) {
        const form = await request.formData();
        return Object.fromEntries(form.entries());
    }
    try {
        return (await request.json()) ?? {};
    } catch {
        return {};
    }
}

/** Read one cookie from a raw Cookie header. */
export function cookieFrom(request, name) {
    const raw = request.headers.get("cookie") ?? "";
    for (const part of raw.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k === name) {
            try {
                return decodeURIComponent(v.join("="));
            } catch {
                return v.join("=");
            }
        }
    }
    return null;
}
