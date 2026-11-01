import { NextResponse } from "next/server";
import { handleRoute } from "@/lib/http";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import { removeOwnedNode } from "@/lib/data/node-api";

export const dynamic = "force-dynamic";

const VALID_ROLES = new Set(["provider", "aggregator", "client"]);

/** DELETE /api/v1/user/nodes/<pubkey>?role=provider */
export async function DELETE(request, { params }) {
    return handleRoute(async () => {
        const user = await getCurrentUser();
        if (!user) {
            const err = new Error("not signed in");
            err.status = 401;
            throw err;
        }

        const { pubkey } = await params;
        if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/i.test(pubkey)) {
            const err = new Error("pubkey must be 64 hexadecimal characters");
            err.status = 400;
            throw err;
        }
        const role = new URL(request.url).searchParams.get("role");
        if (!VALID_ROLES.has(role)) {
            const err = new Error("role must be one of: provider, aggregator, client");
            err.status = 400;
            throw err;
        }

        const result = await removeOwnedNode({ userId: user.id, role, pubkey });
        return NextResponse.json({ data: result });
    });
}
