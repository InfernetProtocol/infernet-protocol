import { NextResponse } from "next/server";
import { getPublicNodeModels } from "@/lib/data/infernet";
import { handleRoute } from "@/lib/http";

/**
 * GET /api/nodes/:id/models — the models one provider advertises
 * (specs.served_models), by row id or node_id. Public, unsigned; private
 * nodes 404 like missing ones. Backs `infernet model list --node <id>`.
 */
export async function GET(_request, { params }) {
  return handleRoute(async () => {
    const { id } = await params;
    const node = await getPublicNodeModels(id);
    if (!node) {
      return NextResponse.json({ error: "node not found" }, { status: 404 });
    }
    return NextResponse.json(
      { data: node },
      { headers: { "cache-control": "public, max-age=30, s-maxage=30" } }
    );
  });
}
