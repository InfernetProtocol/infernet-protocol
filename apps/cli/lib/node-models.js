/**
 * Read a remote node's advertised models from the control plane
 * (GET /api/nodes/:id/models). Backs `infernet model list --node <id>`.
 */
export async function fetchNodeModels({ baseUrl, nodeId, fetchImpl = fetch }) {
    const url = `${baseUrl}/api/nodes/${encodeURIComponent(nodeId)}/models`;
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (res.status === 404) {
        throw new Error(`node ${nodeId} not found (or not public)`);
    }
    if (!res.ok) {
        throw new Error(`GET ${url} -> HTTP ${res.status} ${json?.error ?? text.slice(0, 200)}`);
    }
    return json?.data ?? json;
}

export function formatNodeModels(node) {
    const label = node.name ?? node.node_id ?? node.id;
    const lines = [`node:   ${label}${node.status ? `  (${node.status})` : ""}`];
    if (node.last_seen) lines.push(`seen:   ${node.last_seen}`);
    const models = node.served_models ?? [];
    if (models.length === 0) {
        lines.push("", "(this node advertises no models)");
    } else {
        lines.push("", "MODEL", ...models);
    }
    return lines.join("\n") + "\n";
}
