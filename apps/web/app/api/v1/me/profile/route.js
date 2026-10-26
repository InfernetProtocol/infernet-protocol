import { createProfileHandlers } from "@profullstack/profile";
import { verifyBearerHeader } from "@/lib/auth/bearer";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { userProfileStore } from "@/lib/data/user-profile";

export const dynamic = "force-dynamic";

/**
 * GET / PUT / PATCH /api/v1/me/profile — the caller's contact profile
 * (the shared @profullstack/profile fields). Auth: CLI bearer in the
 * Authorization header, or the Supabase session cookie.
 */
async function resolveUser(request) {
    const claims = verifyBearerHeader(request.headers.get("authorization"));
    if (claims?.sub) return { id: claims.sub, email: claims.email ?? null };
    try {
        const user = await getCurrentUser();
        if (user?.id) return { id: user.id, email: user.email ?? null };
    } catch {
        /* fall through to 401 */
    }
    return null;
}

const handlers = () => createProfileHandlers({ store: userProfileStore(), getUser: resolveUser });

export const GET = (request) => handlers().GET(request);
export const PUT = (request) => handlers().PUT(request);
export const PATCH = (request) => handlers().PATCH(request);
