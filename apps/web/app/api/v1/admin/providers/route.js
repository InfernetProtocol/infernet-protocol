import { requireAdmin, ok } from "@/lib/reservations/http";
import { listDisabledProviders } from "@/lib/data/provider-admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/providers → { disabled: [...] } providers an admin disabled.
 * Authorization: Bearer $INFERNET_ADMIN_TOKEN
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    return ok({ disabled: await listDisabledProviders() });
}
