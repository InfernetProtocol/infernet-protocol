/**
 * Group chat jobs by the node that ran them, for the status page.
 * Pure: rows in, table rows out.
 *
 * Route: "c0mpute node" for a c0mpute worker's provider row (node_id
 * c0mpute:<peer>), "daemon" for an Infernet provider daemon, "hosted" for the
 * hosted fallback (assigned, no provider), and "unserved" for a job nobody
 * took (never assigned, or a c0mpute job no worker answered and nothing else
 * could take).
 */
export function routeOf(job, provider) {
  if (provider) return String(provider.node_id ?? "").startsWith("c0mpute:") ? "c0mpute node" : "daemon";
  return job?.assigned_at && job?.status === "completed" ? "hosted" : "unserved";
}

function fmtSeconds(s) {
  if (!Number.isFinite(s)) return "-";
  if (s < 90) return `${Math.round(s)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

function fmtUsd(n) {
  if (!n) return "$0";
  return n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toFixed(2)}`;
}

export function foldJobsByNode({ jobs = [], providers = [], earnings = [] }) {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const earned = new Map();
  for (const e of earnings) {
    if (!e?.provider_id) continue;
    earned.set(e.provider_id, (earned.get(e.provider_id) ?? 0) + (Number(e.amount_usd) || 0));
  }
  const rows = new Map();
  for (const j of jobs) {
    const provider = j.provider_id ? byId.get(j.provider_id) ?? { id: j.provider_id, name: "unknown node", node_id: "" } : null;
    const route = routeOf(j, provider);
    const key = provider ? provider.id : route;
    const row = rows.get(key) ?? {
      key,
      node: provider ? provider.name : route === "hosted" ? "hosted fallback" : "no node took it",
      route,
      jobs: 0, completed: 0, billed: 0, free: 0,
      seconds: 0, timed: 0,
      models: new Map(),
      earned_usd: provider ? earned.get(provider.id) ?? 0 : 0
    };
    row.jobs += 1;
    if (j.billed_user_id) row.billed += 1; else row.free += 1;
    if (j.status === "completed") {
      row.completed += 1;
      const start = Date.parse(j.assigned_at ?? j.created_at);
      const end = Date.parse(j.completed_at);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        row.seconds += (end - start) / 1000;
        row.timed += 1;
      }
    }
    if (j.model_name) row.models.set(j.model_name, (row.models.get(j.model_name) ?? 0) + 1);
    rows.set(key, row);
  }
  return [...rows.values()]
    .sort((a, b) => b.jobs - a.jobs || String(a.node).localeCompare(String(b.node)))
    .map((r) => ({
      id: r.key,
      key: r.key,
      node: r.node,
      route: r.route,
      jobs: r.jobs,
      completed: r.completed,
      billed_free: `${r.billed} / ${r.free}`,
      avg_time: r.timed ? fmtSeconds(r.seconds / r.timed) : "-",
      top_model: [...r.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-",
      earned: fmtUsd(r.earned_usd),
      earned_usd: r.earned_usd
    }));
}
