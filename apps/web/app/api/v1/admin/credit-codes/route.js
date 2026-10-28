import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import { getCreditDeps, mintCreditCode } from "@/lib/credits";
import { parseMintInput } from "@/lib/credits/core";

export const dynamic = "force-dynamic";

/**
 * Admin: consumer compute-credit codes.
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN (or an admin CLI login).
 *
 * GET  /api/v1/admin/credit-codes → { data: [{ id, label, grant, maxRedemptions, redemptions, expiresAt, revokedAt }] }
 * POST /api/v1/admin/credit-codes { credits, label?, max_redemptions?, expires_at?, monthly? }
 *      → 201 { data: { code, id, ... } }   the plaintext code is returned ONCE (only its sha256 is stored)
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    try {
        return ok(await getCreditDeps().credits.list());
    } catch (err) {
        return fail(500, err.message);
    }
}

export async function POST(request) {
    const { actor, error } = await requireAdmin(request);
    if (error) return error;
    let body;
    try {
        body = await request.json();
    } catch {
        return fail(400, "invalid JSON body");
    }
    const parsed = parseMintInput(body ?? {});
    if (!parsed.ok) return fail(400, parsed.error);
    try {
        return ok(await mintCreditCode(parsed.value, actor), 201);
    } catch (err) {
        return fail(500, err.message);
    }
}
